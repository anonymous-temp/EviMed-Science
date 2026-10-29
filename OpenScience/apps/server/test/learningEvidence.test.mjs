// What the researcher did to a run, kept as evidence (2026-10-23): a steer, a follow-up read once on the next turn, a result corrected, a delivered file taken,
// silence. Since 2026-10-25: `adopt` (the person asks that the way the work was done be kept), steers read by the judge, turns that enter by dispatch, and
// silence that is unknown rather than approval.
//
// The follow-up is the case that was missing — "no, shorter" is the first message of the next turn, and for a native-memory account nothing
// recorded it. The judge is a small model; what its answer is worth is decided in code (the quotation is a substring of the message, an unknown
// method is dropped, a rule or message carrying a credential is never kept), and a failure is no event and a counter.
import assert from "node:assert/strict";
import test from "node:test";

import { LEARNING_FOLLOW_UP_WINDOW_MS, cleanLearningEvidence, isLearningCorrection, learningRunOutcome } from "@evimed/domain";
import { FollowUpJudge, LearningEvidence, LEARNING_EVIDENCE_FAILURES, FOLLOW_UP_JUDGE_INSTRUCTIONS, FOLLOW_UP_JUDGE_OUTCOMES, followUpVerdictFrom, readFollowUp, settleKeyFor, unsafeToKeep } from "../src/learningEvidence.mjs";
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
      // The SQL's definition (`FeedbackEvents.cleanSettledRuns`): a shape-bearing event in the window, the run kept, never corrected.
      return rows.filter((row) => row.detail.scope === scope && Date.parse(row.occurredAt) >= from.getTime() && Date.parse(row.occurredAt) < to.getTime()
        && ["silent", "follow-up", "used"].includes(row.detail.evidence) && row.detail.shape
        && learningRunOutcome(rows.filter((other) => other.runId === row.runId).map((other) => other.detail)) === "clean")
        .map((row) => ({ runId: row.runId, projectId: row.projectId, at: row.occurredAt, shape: row.detail.shape }));
    },
  };
}

/**
 * @param {{ runs?: any[], answer?: string | null | (() => Promise<string | null>) | ((request: any) => Promise<string | null>), refusal?: string | null, ledger?: ReturnType<typeof memoryLedger>, opened?: any[], shapes?: any,
 *   failures?: string[], scripts?: any, judge?: boolean, examples?: any, observed?: string[] }} [options]
 */
function setup({ runs = [finished()], answer = null, refusal = null, ledger = memoryLedger(), opened = methods, shapes = { "report/weekly.md": { format: "md", labels: ["summary", "findings"] } }, failures = [], scripts = null,
  judge: withJudge = true, examples = null, observed = [] } = {}) {
  /** @type {any[]} */ const enqueued = [];
  /** @type {string[]} */ const brought = [];
  /** @type {any[]} */ const lessons = [];
  /** @type {any[]} */ const asked = [];
  const jobs = { enqueue: async (userId, kind, payload, options) => { enqueued.push({ userId, kind, payload, options }); return { id: "job" }; }, bringForward: async (_userId, key) => { brought.push(key); return true; } };
  const triggers = {
    refusalFor: async () => refusal,
    afterCorrection: async (_project, input) => { lessons.push(input); return { queued: ["correction"], skipped: null }; },
    afterAdoption: async (_project, input) => { lessons.push({ ...input, adopted: true }); return { queued: ["adopted"], skipped: null }; },
    queue: async (_project, _run, lesson) => { lessons.push(lesson); return true; },
    guestInfluenced: async () => false,
  };
  const judge = { available: true, read: async (request, owner) => { asked.push({ request, owner }); return typeof answer === "function" ? answer(request) : answer; } };
  const evidence = new LearningEvidence({
    feedback: ledger, jobs, agentRuns: { list: async () => runs }, triggers: () => triggers, judge: withJudge ? /** @type {any} */ (judge) : null, scripts, examples,
    methodsOpened: async () => opened, resolveProject: async () => project, readShapes: async () => shapes, report: (reason) => failures.push(reason),
    observe: (outcome) => observed.push(outcome), now: () => new Date(NOW),
  });
  return { evidence, ledger, enqueued, brought, lessons, asked, failures, observed };
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
  // Without a judge the steers are recorded at once, unread: a correction, as they always were.
  const run = setup({ judge: false });
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

test("steers are read by the judge in steer mode when the run finishes: the newest three, in the background, each row with its verdict, rule and the methods it concerns", async () => {
  const requests = [];
  const run = setup({ answer: async (request) => {
    requests.push(request);
    if (request.message === "再短一点") return verdict({ rule: "回答写得更短", quote: "再短一点", concerns: ["method:learned:weekly-report", "method:learned:made-up"] });
    if (request.message === "好，继续吧") return JSON.stringify({ verdict: "accept" });
    if (request.message === "顺便问一下今天几号") return JSON.stringify({ verdict: "none" });
    return null;
  } });
  const steers = [
    { requestId: "req_old", text: "最早的一条补充", at: "2026-10-23T09:40:00.000Z" },
    { requestId: "req_a", text: "再短一点", at: "2026-10-23T09:50:00.000Z" },
    { requestId: "req_b", text: "好，继续吧", at: "2026-10-23T09:51:00.000Z" },
    { requestId: "req_c", text: "顺便问一下今天几号", at: "2026-10-23T09:52:00.000Z" },
  ];
  const started = Date.now();
  const result = await run.evidence.afterRun(project, finished({ corrections: 4, steers }));
  assert.ok(result.settle, "the settling is queued whatever the judge does");
  await run.evidence.idle();
  assert.ok(Date.now() - started < 5_000);
  const byKey = Object.fromEntries(run.ledger.rows.filter((row) => row.detail.evidence === "steer").map((row) => [row.detail.quote, row.detail]));
  assert.deepEqual([byKey["再短一点"].verdict, byKey["再短一点"].rule], ["correction", "回答写得更短"]);
  assert.deepEqual(byKey["再短一点"].concerns, [{ id: "method:learned:weekly-report", digest: "sha256:aaa" }], "the method it names is the run's");
  assert.equal(byKey["好，继续吧"].verdict, "accept");
  assert.equal(byKey["顺便问一下今天几号"].verdict, "none");
  assert.equal(byKey["最早的一条补充"].verdict, "correction", "the oldest of four was not read: at most the newest three, and an unread steer is a correction");
  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => request.mode === "steer"), "the judge is told the message was typed while the work was running");
  assert.ok(requests.every((request) => request.previousRequest === "写本周周报"));
  assert.deepEqual(run.observed.filter((outcome) => outcome === "steer_judged"), ["steer_judged", "steer_judged", "steer_judged"]);
  // Only the correction-class steer is a correction: the run was not corrected by 「好，继续吧」, and it was by the one that was not read.
  assert.deepEqual(learningRunOutcome(run.ledger.rows.map((row) => row.detail)), "corrected");
  assert.deepEqual(isLearningCorrection(byKey["好，继续吧"]), false);
  assert.deepEqual(isLearningCorrection(byKey["再短一点"]), true);
});

test("a steer the judge could not read is still recorded, unjudged; an adoption is refused for a steer; and the settling records any steer the background reading did not reach", async () => {
  const failing = setup({ answer: null });
  await failing.evidence.afterRun(project, finished({ steers: [{ requestId: "req_a", text: "再短一点", at: "2026-10-23T09:50:00.000Z" }] }));
  await failing.evidence.idle();
  assert.deepEqual(failing.ledger.rows.map((row) => [row.detail.evidence, row.detail.verdict, row.detail.rule]), [["steer", "correction", null]]);
  assert.deepEqual(failing.failures, ["judge_failed"]);

  const adopting = setup({ answer: JSON.stringify({ verdict: "adopt", rule: "周报", quote: "以后都这样", concerns: [] }) });
  await adopting.evidence.afterRun(project, finished({ steers: [{ requestId: "req_a", text: "以后都这样", at: "2026-10-23T09:50:00.000Z" }] }));
  await adopting.evidence.idle();
  assert.deepEqual(adopting.ledger.rows.map((row) => row.detail.verdict), ["correction"], "a run that has not finished cannot be adopted: the steer stays unread");
  assert.deepEqual(adopting.failures, ["judge_unreadable"]);

  // The process went down before the background reading finished: the settling job records the steer, unjudged.
  const restarted = setup({ runs: [finished({ corrections: 1, steers: [{ requestId: "req_a", text: "再短一点", at: "2026-10-23T09:50:00.000Z" }] })] });
  assert.equal((await restarted.evidence.settle({ job: settleJob() })).outcome, "corrected");
  assert.deepEqual(restarted.ledger.rows.map((row) => [row.detail.evidence, row.detail.verdict, row.detail.quote]), [["steer", "correction", "再短一点"]]);
  assert.equal(restarted.asked.length, 0, "the settling reads nothing");
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
  await run.evidence.mirrorResultCorrected(project, { runId: "run_prev", event: { id: "feedback:result-corrected:2", detail: { instruction: "密码是 abcdef123456，写进去" } } });
  assert.deepEqual(run.ledger.rows.map((row) => [row.detail.evidence, row.detail.verdict, row.detail.quote]), [["result-corrected", "correction", "把第二节删掉"], ["result-corrected", "correction", null]]);
  assert.equal(run.ledger.rows[0].occurredAt, "2026-10-23T09:30:00.000Z");
});

// ---------------------------------------------------------------------------------------------------- settling

/** The settle job of a run. @param {string} runId */
const settleJob = (runId = "run_prev") => ({ userId: "u1", projectId: "p1", payload: { runId, sessionId: "ses_1" } });

test("a run nobody reacted to is settled as silent, with the shape of what it left, and counts for nothing; settling twice is settling once", async () => {
  const run = setup({});
  assert.deepEqual(await run.evidence.settle({ job: settleJob() }), { settled: "silent", routine: false, outcome: "unknown" });
  assert.equal(run.ledger.rows.length, 1);
  const [event] = run.ledger.rows;
  assert.deepEqual([event.detail.evidence, event.detail.verdict, event.detail.scope, event.detail.sessionId], ["silent", "none", "conversation", "ses_1"]);
  assert.deepEqual(event.detail.shape, [{ format: "md", labels: ["summary", "findings"] }]);
  assert.deepEqual(await run.evidence.settle({ job: settleJob() }), { settled: "silent", routine: false, outcome: "unknown" });
  assert.equal(run.ledger.rows.length, 1);
});

/** A run's file taken, as the use signal writes it. @param {ReturnType<typeof setup>} run @param {string} [runId] */
const used = (run, runId = "run_prev") => run.ledger.recordLearningEvidence("u1", { runId, projectId: "p1", key: "used", detail: { evidence: "used", at: new Date(NOW).toISOString(), scope: "conversation" } });

test("a run the researcher kept is handed to the script detector when it settles; silence, a corrected run and a run answered about something else are not, and a detector that fails never fails the settling", async () => {
  /** @type {any[]} */ const seen = [];
  const run = setup({ scripts: { afterSettle: async (_project, finishedRun) => { seen.push(finishedRun.id); return { recorded: 0, queued: [] }; } } });
  assert.equal((await run.evidence.settle({ job: settleJob() })).outcome, "unknown");
  assert.deepEqual(seen, [], "a run nobody accepted or used is not read for a program: silence is not approval");
  await used(run);
  assert.deepEqual(await run.evidence.settle({ job: settleJob() }), { settled: "silent", routine: false, outcome: "clean" });
  assert.deepEqual(seen, ["run_prev"], "its file was taken: the run is clean, and read");
  const answered = setup({ scripts: { afterSettle: async () => { seen.push("answered"); } } });
  await answered.ledger.recordLearningEvidence("u1", { runId: "run_prev", projectId: "p1", key: "k", detail: { evidence: "follow-up", verdict: "none", at: new Date(NOW).toISOString(), scope: "conversation" } });
  assert.equal((await answered.evidence.settle({ job: settleJob() })).outcome, "unknown", "a message about something else says nothing about the work");
  const accepted = setup({ scripts: { afterSettle: async () => { seen.push("accepted"); } } });
  await accepted.ledger.recordLearningEvidence("u1", { runId: "run_prev", projectId: "p1", key: "k", detail: { evidence: "follow-up", verdict: "accept", at: new Date(NOW).toISOString(), scope: "conversation" } });
  assert.equal((await accepted.evidence.settle({ job: settleJob() })).outcome, "clean");
  const corrected = setup({ scripts: { afterSettle: async () => { seen.push("corrected"); } } });
  await used(corrected);
  await corrected.ledger.recordLearningEvidence("u1", { runId: "run_prev", projectId: "p1", key: "k", detail: { evidence: "steer", quote: "再短一点", at: new Date(NOW).toISOString(), scope: "conversation" } });
  assert.equal((await corrected.evidence.settle({ job: settleJob() })).settled, "corrected");
  assert.deepEqual(seen, ["run_prev", "accepted"], "a corrected run is not read for a program, however it was used");
  const failing = setup({ scripts: { afterSettle: async () => { throw new Error("executor down"); } } });
  await used(failing);
  assert.deepEqual(await failing.evidence.settle({ job: settleJob() }), { settled: "silent", routine: false, outcome: "clean" });
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
    { evidence: "steer", verdict: "preference", rule: "更短", quote: "再短一点" },
    { evidence: "follow-up", verdict: "preference", rule: "以后都用表格", quote: "以后都用表格" },
    { evidence: "result-corrected", quote: "把第二节删掉" },
  ]) {
    const run = setup({});
    await run.ledger.recordLearningEvidence("u1", { runId: "run_prev", projectId: "p1", key: "k", detail: { ...reaction, at: new Date(NOW).toISOString(), scope: "conversation" } });
    assert.deepEqual(await run.evidence.settle({ job: settleJob() }), { settled: "corrected", routine: false, outcome: "corrected" }, JSON.stringify(reaction));
    assert.equal(run.ledger.rows.length, 1);
  }
  // A steer its judge read as nothing is no correction, and a follow-up that accepted it is a settlement already: no silence beside it.
  const calm = setup({});
  await calm.ledger.recordLearningEvidence("u1", { runId: "run_prev", projectId: "p1", key: "k", detail: { evidence: "steer", verdict: "accept", quote: "好，继续", at: new Date(NOW).toISOString(), scope: "conversation" } });
  assert.equal((await calm.evidence.settle({ job: settleJob() })).outcome, "unknown", "the judge read the steer as approval of the work so far, which says nothing of the delivery");
  const accepted = setup({});
  await accepted.ledger.recordLearningEvidence("u1", { runId: "run_prev", projectId: "p1", key: "k", detail: { evidence: "follow-up", verdict: "accept", at: new Date(NOW).toISOString(), scope: "conversation" } });
  assert.deepEqual(await accepted.evidence.settle({ job: settleJob() }), { settled: "follow-up", routine: false, outcome: "clean" });
  assert.equal(accepted.ledger.rows.length, 1);
});

test("the third KEPT run of one shape in a scope completes a routine; silence, a corrected run and another scope's do not count; the gates apply", async () => {
  const period = routinePeriodMs(ROUTINE_PERIOD_DAYS);
  const run = setup({});
  const at = new Date(NOW).toISOString();
  const shape = [{ format: "md", labels: ["summary", "findings"] }];
  const settle = (runId) => run.evidence.settle({ job: settleJob(runId) });
  /** @param {string} runId @param {string} projectId @param {string} evidence */
  const familyRow = (runId, projectId, evidence) => ({ id: `${evidence}:${runId}`, userId: "u1", projectId, runId, occurredAt: at, trigger: "learning-evidence",
    detail: evidence === "follow-up" ? { evidence, verdict: "accept", scope: "conversation", shape, at } : { evidence, verdict: "none", scope: "conversation", ...(evidence === "silent" ? { shape } : {}), at } });
  // Two earlier runs: one accepted on the next turn, one whose file was taken after it settled silently.
  run.ledger.rows.push(familyRow("fam_1", "p1", "follow-up"), familyRow("fam_2", "other", "silent"), familyRow("fam_2", "other", "used"));
  // The run that settles is itself kept: its file was taken.
  await used(run);
  const result = await settle("run_prev");
  assert.deepEqual(result, { settled: "silent", routine: true, outcome: "clean" });
  const lesson = run.lessons.find((entry) => entry.trigger === "routine");
  assert.equal(lesson.idempotencyKey, "distill:run_prev:routine");
  assert.deepEqual(lesson.payload.peers, [{ runId: "fam_1", projectId: "p1" }, { runId: "fam_2", projectId: "other" }]);
  assert.equal(lesson.payload.scope, "conversation");

  // Silence is not family, and a family member that was later corrected is not family; this run is kept but is the second of three at most.
  const unkept = setup({});
  unkept.ledger.rows.push(familyRow("fam_1", "p1", "silent"), familyRow("fam_2", "p1", "silent"), familyRow("fam_2", "p1", "result-corrected"));
  await used(unkept);
  assert.deepEqual(await unkept.evidence.settle({ job: settleJob() }), { settled: "silent", routine: false, outcome: "clean" });
  assert.equal(unkept.lessons.length, 0, "silent runs count for nothing, so three of them are not a routine");
  assert.equal(period > 0, true);

  // Another scope's runs, and the gates.
  const other = setup({ runs: [finished({ effectiveAgentId: "geo-content" })] });
  other.ledger.rows.push(familyRow("x", "p1", "follow-up"), familyRow("y", "p1", "follow-up"));
  await used(other);
  assert.equal((await other.evidence.settle({ job: settleJob() })).routine, false, "the family is the scope's");
  assert.deepEqual(await setup({ refusal: "paused" }).evidence.settle({ job: settleJob() }), { settled: null, routine: false, skipped: "paused" });
  assert.deepEqual(await setup({ runs: [] }).evidence.settle({ job: settleJob() }), { settled: null, routine: false, skipped: "run_unavailable" });
});

test("a run whose files left no readable shape is settled but never counted towards a routine", async () => {
  const run = setup({ shapes: {} });
  await used(run);
  assert.deepEqual(await run.evidence.settle({ job: settleJob() }), { settled: "silent", routine: false, outcome: "clean" });
  assert.equal(run.ledger.rows.find((row) => row.detail.evidence === "silent").detail.shape, undefined);
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

// ---------------------------------------------------------------------------------------------------- adopt (2026-10-25, owner decision 4)

const adoptAnswer = (extra = {}) => JSON.stringify({ verdict: "adopt", rule: "周报都按刚才的做法写", quote: "以后周报都按这个来", concerns: ["method:learned:weekly-report"], ...extra });
const ADOPT_MESSAGE = "这个格式很好，以后周报都按这个来。";

test("an adoption carries a rule and a quotation of the person's words like a correction does, names no method, and is never a steer's", () => {
  const message = ADOPT_MESSAGE;
  assert.deepEqual(followUpVerdictFrom(adoptAnswer(), { message, methods }), {
    verdict: "adopt", rule: "周报都按刚才的做法写", quote: "以后周报都按这个来", concerns: [],
  }, "an adoption is clean: the methods the model named are dropped, so it can never count as a correction of one");
  assert.deepEqual(followUpVerdictFrom(adoptAnswer({ quote: "以后所有周报都按这个来" }), { message, methods }), { failure: "quote_not_found" }, "a paraphrase is no evidence");
  assert.deepEqual(followUpVerdictFrom(adoptAnswer({ quote: null }), { message, methods }), { failure: "quote_not_found" });
  assert.deepEqual(followUpVerdictFrom(adoptAnswer({ rule: "" }), { message, methods }), { failure: "judge_unreadable" });
  assert.deepEqual(followUpVerdictFrom(adoptAnswer({ rule: "周报 api_key: abcdef1234567890" }), { message, methods }), { failure: "rule_unsafe" });
  assert.deepEqual(followUpVerdictFrom(adoptAnswer(), { message, methods, mode: "steer" }), { failure: "judge_unreadable" }, "work still going cannot be adopted");
  assert.equal(followUpVerdictFrom(JSON.stringify({ verdict: "accept" }), { message, methods, mode: "steer" }).verdict, "accept");
  assert.equal(followUpVerdictFrom(verdict({ quote: "不对，每节只要三行" }), { message: "不对，每节只要三行", methods, mode: "steer" }).verdict, "correction");
  assert.ok(LEARNING_EVIDENCE_FAILURES.includes("adopt_unconfirmed") && LEARNING_EVIDENCE_FAILURES.includes("adopt_without_delivery"));
  assert.deepEqual(FOLLOW_UP_JUDGE_OUTCOMES, ["adopt_confirmed", "adopt_disagreed", "examples_embedding", "examples_ngram", "steer_judged"]);
});

test("a keyword is not what makes a message unsafe: 「把密码列去掉」 is read, a secret assigned to a name is not", () => {
  assert.equal(unsafeToKeep("把表里的密码列去掉，token 也不要"), false, "language about passwords is language");
  assert.equal(unsafeToKeep("我患有高血压，帮我整理成表"), false);
  assert.equal(unsafeToKeep("密码是 hunter2hunter2"), true, "a secret assigned to a name is a shape");
  assert.equal(unsafeToKeep("我的手机号 13800138000"), true);
  assert.equal(unsafeToKeep(`key ${["sk", "a".repeat(36)].join("-")}`), true);
});

test("the judge's instructions carry the fixed contrasts, and its request the examples in the order given and the mode only when asked", async () => {
  assert.match(FOLLOW_UP_JUDGE_INSTRUCTIONS, /- adopt:/);
  assert.match(FOLLOW_UP_JUDGE_INSTRUCTIONS, /Close calls, as they were decided/);
  assert.match(FOLLOW_UP_JUDGE_INSTRUCTIONS, /这次就这样吧.*→ accept/, "「这次就这样吧」 is accept");
  assert.match(FOLLOW_UP_JUDGE_INSTRUCTIONS, /以后周报都按这个来.*→ adopt/);
  assert.doesNotMatch(FOLLOW_UP_JUDGE_INSTRUCTIONS, /\b(?:regex|keyword)\b/i);
  const calls = [];
  const judge = new FollowUpJudge({ deepseekProviderEnabled: true, deepseekApiKey: "k", deepseekModel: "m" }, { callModel: async (_deps, call) => { calls.push(call.body); return { choices: [{ message: { content: "{}" } }] }; } });
  const examples = [{ id: "a", previousRequest: "写周报", message: "太长了", verdict: "correction", quote: "太长了", why: "w1" }, { id: "b", previousRequest: "写邮件", message: "好的", verdict: "accept", quote: null, why: "w2" }];
  await judge.read({ message: "短点", previousRequest: "写周报", methods: [], examples, mode: "steer" }, { userId: "u", projectId: "p", runId: "r" });
  const user = JSON.parse(calls[0].messages[1].content);
  assert.deepEqual(Object.keys(user), ["message", "previousRequest", "methods", "examples", "mode"]);
  assert.deepEqual(user.examples.map((example) => example.message), ["太长了", "好的"], "in the order given");
  assert.deepEqual(Object.keys(user.examples[0]), ["previousRequest", "message", "verdict", "quote", "why"], "no id and no language tag: what a reader needs");
  assert.equal(user.mode, "steer");
  await judge.read({ message: "短点", previousRequest: "写周报", methods: [] }, { userId: "u", projectId: "p", runId: "r" });
  assert.deepEqual(Object.keys(JSON.parse(calls[1].messages[1].content)), ["message", "previousRequest", "methods"]);
});

test("an adoption stands only when a second reading, with the examples in the other order, says it too; otherwise the second verdict, or none, and a counter", async () => {
  const bank = [{ id: "e1", previousRequest: "q", message: "最像的例子", verdict: "adopt", quote: "最像", why: "w" }, { id: "e2", previousRequest: "q", message: "较像的例子", verdict: "accept", quote: null, why: "w" }, { id: "e3", previousRequest: "q", message: "不太像的例子", verdict: "none", quote: null, why: "w" }];
  const examples = { select: async () => ({ examples: bank, mode: "embedding" }) };
  const run = async (answers, { adoptable = true } = {}) => {
    const seen = [];
    const observed = [];
    const judge = { read: async (request) => { seen.push(request.examples?.map((example) => example.id)); return answers.shift() ?? null; } };
    const result = await readFollowUp({ judge, examples, observe: (outcome) => observed.push(outcome) }, { message: ADOPT_MESSAGE, previousRequest: "写周报", methods: [], adoptable }, { userId: "u", projectId: "p", runId: "r" });
    return { result, seen, observed };
  };
  const agreed = await run([adoptAnswer(), adoptAnswer()]);
  assert.equal(agreed.result.verdict, "adopt");
  assert.deepEqual(agreed.seen, [["e3", "e2", "e1"], ["e1", "e2", "e3"]], "the nearest example is the last the first time and the first the second time");
  assert.deepEqual(agreed.observed, ["examples_embedding", "adopt_confirmed"]);
  for (const second of ["accept", "preference", "correction"]) {
    const answer = second === "accept" ? JSON.stringify({ verdict: "accept" }) : JSON.stringify({ verdict: second, rule: "周报按这个来", quote: "以后周报都按这个来", concerns: [] });
    const split = await run([adoptAnswer(), answer]);
    assert.equal(split.result.verdict, second, `the second reading's ${second} is taken`);
    assert.deepEqual(split.observed, ["examples_embedding", "adopt_disagreed"]);
  }
  for (const second of [JSON.stringify({ verdict: "none" }), JSON.stringify({ verdict: "rejection", rule: "重做", quote: "以后周报都按这个来", concerns: [] }), "not json", null]) {
    const unconfirmed = await run([adoptAnswer(), second]);
    assert.deepEqual(unconfirmed.result, { failure: "adopt_unconfirmed" }, "never a softened verdict");
  }
  // Only the first reading is adopted when its grounding fails.
  assert.deepEqual((await run([adoptAnswer({ quote: "编造的话" })])).result, { failure: "quote_not_found" });
  // A first reading that is not an adoption is the verdict, with one call only.
  const plain = await run([JSON.stringify({ verdict: "accept" })]);
  assert.equal(plain.result.verdict, "accept");
  assert.equal(plain.seen.length, 1);
  // A run that delivered nothing has nothing to keep: refused after one call.
  const empty = await run([adoptAnswer()], { adoptable: false });
  assert.deepEqual(empty.result, { failure: "adopt_without_delivery" });
  assert.equal(empty.seen.length, 1);
  // A judge that fails is the failure, whatever the examples did.
  assert.deepEqual((await run([null])).result, { failure: "judge_failed" });
  // Without a selector the request carries no examples, and a selector that throws changes nothing but the examples.
  const bare = [];
  await readFollowUp({ judge: { read: async (request) => { bare.push(request.examples); return JSON.stringify({ verdict: "none" }); } }, examples: { select: async () => { throw new Error("down"); } } },
    { message: "好", previousRequest: "", methods: [] }, { userId: "u", projectId: "p", runId: "r" });
  assert.deepEqual(bare, [undefined]);
});

test("an adoption on the next turn is evidence that keeps the run and queues its lesson at once, with the shape of what was kept", async () => {
  const run = setup({ answer: adoptAnswer() });
  const result = await run.evidence.onNewTurn(project, { sessionId: "ses_1", text: ADOPT_MESSAGE, requestId: "req_adopt" });
  assert.deepEqual(result, { recorded: true, verdict: "adopt", runId: "run_prev", queued: ["adopted"] });
  const [event] = run.ledger.rows;
  assert.deepEqual([event.detail.evidence, event.detail.verdict, event.detail.quote, event.detail.concerns], ["follow-up", "adopt", "以后周报都按这个来", []]);
  assert.deepEqual(event.detail.shape, [{ format: "md", labels: ["summary", "findings"] }], "an adopted run is clean, so it carries its shape for a routine");
  assert.equal(run.lessons.length, 1);
  assert.equal(run.lessons[0].adopted, true, "the adoption lesson, not the correction's");
  assert.equal(run.lessons[0].runId, "run_prev");
  assert.deepEqual(run.brought, [settleKeyFor("run_prev")]);
  assert.equal(learningRunOutcome(run.ledger.rows.map((row) => row.detail)), "clean");
  // Settled, it is clean, and a second reading was asked for.
  assert.equal(run.asked.length, 2);
});

test("an adoption of a run that delivered nothing is refused and counted; one that cannot be confirmed is no evidence at all", async () => {
  const nothing = setup({ answer: adoptAnswer(), runs: [finished({ outputFiles: [], transcript: { completeness: "complete", messages: 1 }, observedMessages: 1 })] });
  assert.deepEqual(await nothing.evidence.onNewTurn(project, { sessionId: "ses_1", text: ADOPT_MESSAGE, requestId: "r" }), { recorded: false, reason: "adopt_without_delivery" });
  assert.deepEqual(nothing.failures, ["adopt_without_delivery"]);
  assert.equal(nothing.ledger.rows.length + nothing.lessons.length, 0);
  // An answer in the conversation is something to keep: the ledger counts more than the question.
  const answered = setup({ answer: adoptAnswer(), runs: [finished({ outputFiles: [], transcript: { completeness: "complete", messages: 4 } })] });
  assert.equal((await answered.evidence.onNewTurn(project, { sessionId: "ses_1", text: ADOPT_MESSAGE, requestId: "r" })).verdict, "adopt");
  assert.equal(answered.ledger.rows[0].detail.shape, undefined, "no file, no shape");
  const answers = [adoptAnswer(), JSON.stringify({ verdict: "none" })];
  const split = setup({ answer: async () => answers.shift() ?? null });
  assert.deepEqual(await split.evidence.onNewTurn(project, { sessionId: "ses_1", text: ADOPT_MESSAGE, requestId: "r" }), { recorded: false, reason: "adopt_unconfirmed" });
  assert.deepEqual(split.failures, ["adopt_unconfirmed"]);
  assert.equal(split.ledger.rows.length + split.lessons.length, 0);
  // A second reading that says accept is an acceptance: clean, and no lesson.
  const second = [adoptAnswer(), JSON.stringify({ verdict: "accept" })];
  const accepted = setup({ answer: async () => second.shift() ?? null });
  assert.deepEqual(await accepted.evidence.onNewTurn(project, { sessionId: "ses_1", text: ADOPT_MESSAGE, requestId: "r" }), { recorded: true, verdict: "accept", runId: "run_prev", queued: [] });
});

test("a message that reaches the conversation through the control plane's dispatch is read as a turn from the kernel page is, and the run it reserved is neither the one it reacts to nor one still going", async () => {
  const reserved = finished({ id: "run_new", dispatchId: "dsp_1", status: "running", finishedAt: null, question: "不对，每节只要三行" });
  const run = setup({ runs: [finished(), reserved], answer: verdict() });
  assert.deepEqual(await run.evidence.onNewTurn(project, { sessionId: "ses_1", text: "不对，每节只要三行，别再写长了", requestId: "dsp_1" }), { recorded: false, reason: "run_in_progress" }, "without naming the dispatch the reserved run reads as a run still going");
  const named = setup({ runs: [finished(), reserved], answer: verdict() });
  assert.deepEqual(await named.evidence.onNewTurn(project, { sessionId: "ses_1", text: "不对，每节只要三行，别再写长了", requestId: "dsp_1", dispatchId: "dsp_1" }),
    { recorded: true, verdict: "correction", runId: "run_prev", queued: ["correction"] });
  // A run that is going before this dispatch still holds it back.
  const busy = setup({ runs: [finished(), finished({ id: "run_going", status: "running", finishedAt: null }), reserved], answer: verdict() });
  assert.deepEqual(await busy.evidence.onNewTurn(project, { sessionId: "ses_1", text: "不对", requestId: "dsp_1", dispatchId: "dsp_1" }), { recorded: false, reason: "run_in_progress" });
});

// ---------------------------------------------------------------------------------------------------- a file taken

/** @param {Record<string, any>} [extra] */
const taken = (extra = {}) => finished({ artifacts: [{ path: "report/final.docx" }], presentedFiles: ["handout/slides.pptx"], ...extra });

test("a delivered file the owner opens is the run's use, once, with no words; a file no run delivered, a run still going and one the loop may not read are nothing", async () => {
  const run = setup({ runs: [taken()] });
  assert.deepEqual(await run.evidence.noteFileUse(project, { path: "report/weekly.md" }), { recorded: true, runId: "run_prev" });
  const [event] = run.ledger.rows;
  assert.deepEqual([event.detail.evidence, event.detail.verdict, event.detail.quote, event.detail.rule, event.detail.scope, event.detail.sessionId], ["used", "none", null, null, "conversation", "ses_1"]);
  assert.equal(event.detail.endedAt, finished().finishedAt);
  assert.equal(run.enqueued.length, 0, "a use inside the window leaves the settling to its job");
  // Once per run, however many of its files are opened and however often.
  assert.deepEqual(await run.evidence.noteFileUse(project, { path: "report/weekly.md" }), { recorded: false, reason: "seen" });
  assert.deepEqual(await run.evidence.noteFileUse(project, { path: "report/final.docx" }), { recorded: false, reason: "already_used", runId: "run_prev" });
  assert.deepEqual(await run.evidence.noteFileUse(project, { path: "handout/slides.pptx" }), { recorded: false, reason: "already_used", runId: "run_prev" });
  assert.equal(run.ledger.rows.length, 1);
  // The path as the kernel frame names it, and as the files route does, is the same file.
  const frame = setup({ runs: [taken()] });
  assert.equal((await frame.evidence.noteFileUse(project, { path: "./report//final.docx" })).reason, "not_delivered", "a path is compared as written, normalised only for its ends");
  assert.equal((await frame.evidence.noteFileUse(project, { path: "/report/final.docx" })).recorded, true);
  // Nothing: no run delivered it, the run is still going, the run is another's, a path with nothing in it.
  assert.deepEqual(await setup({ runs: [taken()] }).evidence.noteFileUse(project, { path: "uploads/data.csv" }), { recorded: false, reason: "not_delivered" });
  assert.deepEqual(await setup({ runs: [taken({ status: "running", finishedAt: null })] }).evidence.noteFileUse(project, { path: "report/weekly.md" }), { recorded: false, reason: "not_delivered" });
  assert.deepEqual(await setup({ runs: [taken()], refusal: "not_researcher_work" }).evidence.noteFileUse(project, { path: "report/weekly.md" }), { recorded: false, reason: "not_researcher_work" });
  assert.deepEqual(await run.evidence.noteFileUse(project, { path: "" }), { recorded: false, reason: "no_path" });
  // The newest run that delivered the file is the one used.
  const newer = finished({ id: "run_new", startedAt: new Date(NOW - 20 * 60_000).toISOString(), finishedAt: new Date(NOW - 2 * 60_000).toISOString() });
  const both = setup({ runs: [finished(), newer] });
  assert.equal((await both.evidence.noteFileUse(project, { path: "report/weekly.md" })).runId, "run_new");
});

test("a use after the run was settled completes the settling: the run is clean from then, and a routine or a program is looked for", async () => {
  /** @type {string[]} */ const seen = [];
  const stale = finished({ finishedAt: new Date(NOW - LEARNING_FOLLOW_UP_WINDOW_MS - 10 * 60_000).toISOString() });
  const run = setup({ runs: [stale], scripts: { afterSettle: async (_project, finishedRun) => { seen.push(finishedRun.id); } } });
  // The settling ran: silence, which counts for nothing.
  assert.equal((await run.evidence.settle({ job: settleJob() })).outcome, "unknown");
  assert.deepEqual(seen, []);
  assert.deepEqual(await run.evidence.noteFileUse(project, { path: "report/weekly.md" }), { recorded: true, runId: "run_prev" });
  assert.deepEqual(seen, ["run_prev"], "the late use made it clean, and it was read for a program");
  assert.equal(learningRunOutcome(run.ledger.rows.map((row) => row.detail)), "clean");
  // The routine it completes: two earlier kept runs of the same shape.
  const at = new Date(NOW).toISOString();
  const shape = [{ format: "md", labels: ["summary", "findings"] }];
  const third = setup({ runs: [stale] });
  third.ledger.rows.push(...["fam_1", "fam_2"].map((runId, index) => ({ id: `f${index}`, userId: "u1", projectId: "p1", runId, occurredAt: at, trigger: "learning-evidence",
    detail: { evidence: "follow-up", verdict: "accept", scope: "conversation", shape, at } })));
  await third.evidence.settle({ job: settleJob() });
  assert.equal(third.lessons.length, 0, "settled in silence: not yet counted");
  await third.evidence.noteFileUse(project, { path: "report/weekly.md" });
  assert.equal(third.lessons.find((lesson) => lesson.trigger === "routine")?.idempotencyKey, "distill:run_prev:routine");
  // A use that arrives inside the window leaves the settling to its job; a store that fails never throws.
  const early = setup({ runs: [finished()] });
  await early.evidence.noteFileUse(project, { path: "report/weekly.md" });
  assert.equal(early.lessons.length, 0);
  const broken = setup({ runs: [finished()] });
  broken.ledger.recordLearningEvidence = async () => { throw new Error("database down"); };
  assert.deepEqual(await broken.evidence.noteFileUse(project, { path: "report/weekly.md" }), { recorded: false, reason: "record_failed" });
  assert.deepEqual(broken.failures, ["record_failed"]);
});
