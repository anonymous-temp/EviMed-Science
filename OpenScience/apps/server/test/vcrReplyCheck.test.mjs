// The numbers a 虚拟临研 conversation says it computed, held against the study's engine results: which numbers are results is the
// reviewer's language judgement (stubbed here), whether they are in the results is arithmetic, and a number not found is a ⚠ — a notice,
// the reply untouched. The pure half first, then the reply check on PostgreSQL with the reviewer's wire stubbed.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { UsageLedger } from "../src/usageLedger.mjs";
import { migrateUsageLedger } from "../src/usagePersistence.mjs";
import { ReviewService } from "../src/reviewService.mjs";
import {
  VCR_REPLY_NUMBER_REASON, acceptReplyClaims, collectNumbers, numberIsFound, parseWrittenNumber, replyNumberSentences, studyNumbers, vcrReplyMessage,
  vcrReplySystemPrompt, vcrReplyVerdicts,
} from "../src/vcrReplyCheck.mjs";

const found = (/** @type {string} */ written, /** @type {number[]} */ candidates) => numberIsFound(/** @type {any} */ (parseWrittenNumber(written)), candidates);

test("a reply's sentences with a number are what the reviewer is shown; prose only, bounded", () => {
  const reply = ["在 HR 0.7 的设定下，1:1 固定设计需要 845 例事件。", "这个设计更稳妥。", "```", "x = 91.5", "```", "模拟功效 91.5%（±0.4）；2:1 要多 105 例。", "参考 [1]。"].join("\n");
  const sentences = replyNumberSentences(reply);
  assert.deepEqual(sentences.map((entry) => entry.sentence), ["在 HR 0.7 的设定下，1:1 固定设计需要 845 例事件。", "模拟功效 91.5%（±0.4）；", "2:1 要多 105 例。", "参考 [1]。"]);
  assert.equal(replyNumberSentences("没有数字的回答。").length, 0);
  assert.equal(replyNumberSentences(Array.from({ length: 80 }, (_, i) => `第 ${i} 句 ${i}。`).join("")).length, 40, "at most forty sentences go to the reviewer");
  assert.match(vcrReplyMessage(sentences), /^<sentences>\nS0：/);
  assert.match(vcrReplySystemPrompt(), /年份和日期/);
});

test("a number as written has a value, the decimals it was printed to, and whether it was a percentage", () => {
  assert.deepEqual(parseWrittenNumber("91.5%"), { value: 91.5, decimals: 1, percent: true });
  assert.deepEqual(parseWrittenNumber("11,799"), { value: 11799, decimals: 0, percent: false });
  assert.deepEqual(parseWrittenNumber("±0.4"), { value: 0.4, decimals: 1, percent: false });
  assert.deepEqual(parseWrittenNumber("845 "), { value: 845, decimals: 0, percent: false });
  for (const bad of ["", "约 845", "1,2", "八百", "NaN", "12abc"]) assert.equal(parseWrittenNumber(bad), null, bad);
});

test("a number is found when it is one of the study's numbers within rounding — and in no other sense of close", () => {
  const numbers = [0.915, 845, 11799, 0.0040, 13764];
  assert.equal(found("91.5%", numbers), true, "a percentage is the proportion");
  assert.equal(found("0.915", numbers), true);
  assert.equal(found("92%", numbers), true, "91.5 rounds to 92 at the unit it is printed in");
  assert.equal(found("93%", numbers), false, "a point and a half is not rounding");
  assert.equal(found("91%", [91.5]), true, "91 is 91.5 to the unit it is printed in");
  assert.equal(found("845", numbers), true);
  assert.equal(found("850", numbers), false, "850 is not 845: the unit of 850 is one");
  assert.equal(found("11,800", numbers), true, "11,800 is 11,799 to three significant digits");
  assert.equal(found("11,900", numbers), false);
  assert.equal(found("13,764", numbers), true);
  assert.equal(found("0.4%", numbers), true, "an error written as a percentage");
  assert.equal(found("1,000", numbers), false);
});

test("what the study holds: results of every stage, the settings it was given, what each job ran, and the differences between designs", () => {
  const held = studyNumbers({
    results: [
      { measures: [{ name: "required_events", value: 950 }, { name: "power", value: 0.898, mcse: 0.004 }], counts: { generatedRecords: 1000 }, diagnostics: { profile: [{ mean: 63.01 }] } },
      { measures: [{ name: "required_events", value: 845 }, { name: "power", value: 0.915, mcse: 0.004 }], counts: {}, diagnostics: {} },
    ],
    inputs: [[{ point: 0.7, distribution: { range: { low: 0.55, high: 0.9 } } }], [{ design: { nTreat: 120, nControl: 60 } }]],
    executions: [{ replicates: 5000, seed: 7 }],
  });
  const has = (/** @type {number} */ value) => held.some((candidate) => Math.abs(candidate - value) < 1e-9);
  for (const value of [950, 845, 0.898, 89.8, 91.5, 1000, 63.01, 0.7, 70, 120, 60, 5000]) assert.ok(has(value), String(value));
  assert.ok(has(105), "「2:1 要多 105 例事件」: the difference of two designs' results");
  assert.ok(has(1.7), "and of two powers, in points");
  assert.ok(!has(850));
  assert.deepEqual(collectNumbers({ a: [1, { b: 2 }], c: "3", d: Number.NaN }, []), [1, 2]);
});

test("the reviewer's claims are re-read by code: a sentence it was shown, a number written in it, a number that parses — nothing else stands", () => {
  const sentences = [{ index: 0, sentence: "1:1 固定设计需要 845 例事件，约 11,800 名患者。" }, { index: 2, sentence: "模拟功效 91.5%。" }];
  const accepted = acceptReplyClaims({ claims: [
    { sentence: 0, numbers: ["845", "11,800", "1:1", "9999"] },
    { sentence: 1, numbers: ["91.5%"] },
    { sentence: 2, numbers: ["91.5%", "91.5%", "92"] },
    { sentence: "2", numbers: ["91.5%"] },
  ] }, sentences);
  assert.deepEqual(accepted.map((claim) => [claim.index, claim.numbers.map((entry) => entry.written)]), [[0, ["845", "11,800"]], [2, ["91.5%"]]]);
  assert.deepEqual(acceptReplyClaims(null, sentences), []);
  assert.deepEqual(acceptReplyClaims({ claims: "nope" }, sentences), []);
});

test("a number the study does not hold is a ⚠ on its sentence with the reason and the number; a sentence whose numbers are all held says nothing", () => {
  const claims = acceptReplyClaims({ claims: [{ sentence: 0, numbers: ["845", "850"] }, { sentence: 1, numbers: ["91.5%"] }] },
    [{ index: 0, sentence: "需要 845 例事件，也就是 850 例。" }, { index: 1, sentence: "功效 91.5%。" }]);
  const verdicts = vcrReplyVerdicts({ claims, candidates: studyNumbers({ results: [{ measures: [{ name: "required_events", value: 845 }, { name: "power", value: 0.915 }] }] }) });
  assert.equal(verdicts.length, 1);
  assert.deepEqual([verdicts[0].verdict, verdicts[0].reason, verdicts[0].by, verdicts[0].text], ["unsupported", `${VCR_REPLY_NUMBER_REASON}：850`, "vcr-results", "需要 845 例事件，也就是 850 例。"]);
  assert.equal(verdicts[0].source, null);
  assert.ok(verdicts[0].sentence >= 1000, "kept apart from the citation check's own sentence numbers");
});

// --- the reply check on PostgreSQL ------------------------------------------------------------------------------------

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const userId = `review_vcr_user_${randomUUID()}`;
const projectId = "review-vcr-project";
/** @type {any} */
let database;
const config = {
  reviewEnabled: true, reviewRepliesEnabled: true, reviewModel: "qwen3.8-max-0902", reviewApiBase: "https://dashscope.example/compatible-mode/v1",
  reviewReplyTimeoutMs: 10_000, reviewReplyConcurrency: 2, dashscopeApiKey: "test-dashscope-key", userDailySpendLimit: 0, userWeeklySpendLimit: 0,
  reviewJevEnabled: false,
};

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 6, databaseConnectionTimeoutMs: 2_000 });
  await database.migrate();
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Reviewer vcr test','development')", [userId]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,'Review vcr',1048576)", [userId, projectId]);
  await migrateUsageLedger(database);
});
after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id=$1", [userId]);
  await database.close();
});

/** @param {any} value */
function reviewerAnswer(value) {
  const events = [
    { id: "chatcmpl-x", model: "qwen3.8-max-0902", choices: [{ index: 0, delta: { content: JSON.stringify(value) } }] },
    { id: "chatcmpl-x", model: "qwen3.8-max-0902", choices: [], usage: { prompt_tokens: 600, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 0 } } },
  ];
  return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const FACTS = { studyId: "std_1", results: [{ measures: [{ name: "required_events", value: 845 }, { name: "power", value: 0.915, mcse: 0.004 }], counts: {}, diagnostics: {} }], inputs: [], executions: [{ replicates: 5000 }] };

/** @param {(body: any) => Response} reviewer @param {any} [facts] */
function service(reviewer, facts = FACTS) {
  /** @type {any[]} */
  const calls = [];
  const review = new ReviewService({
    config, database, usageLedger: new UsageLedger(database), retryDelayMs: 0,
    store: { userById: async () => ({ id: userId }), requireProject: async () => ({ id: projectId, userId }) },
    vcrFacts: async (identity) => { calls.push(identity); return facts; },
    fetchImpl: /** @type {any} */ (async (/** @type {string} */ _url, /** @type {any} */ init) => reviewer(JSON.parse(init.body))),
    referenceResolver: { resolve: async () => ({ doi: new Map(), pmid: new Map() }), sourceTexts: async () => new Map() },
  });
  return { review, calls };
}

test("a reply in a study's conversation that reports a number the engine did not compute gets the ⚠ the reply check draws, and the numbers it got right get nothing", options, async () => {
  const { review, calls } = service((body) => {
    const shown = body.messages[1].content;
    assert.match(shown, /^<sentences>/);
    assert.match(shown, /S0：.*845/, "the sentences with a number are what the reviewer sees");
    return reviewerAnswer({ claims: [{ sentence: 0, numbers: ["845", "11,800"] }, { sentence: 1, numbers: ["91.5%", "93.1%"] }, { sentence: 99, numbers: ["1"] }] });
  });
  const identity = { userId, projectId };
  const reply = "1:1 固定设计需要 845 例事件，约 11,800 名患者。\n模拟功效 91.5%，不过我估计在 93.1% 左右也说得过去。\n你想先看哪个方案？";
  assert.ok(await review.considerReply(identity, { id: "run_vcr_1", sessionId: "chat-vcr" }, { replyText: reply, question: "样本量？", turnSeq: 3 }, { studyId: "std_1" }));
  assert.equal(await review.processReplyChecks("worker-vcr"), 1);
  assert.deepEqual(calls, [identity]);
  const [check] = await review.replyChecksForSession(identity, "chat-vcr");
  assert.equal(check.status, "done");
  assert.equal(check.verdicts.length, 2, "11,800 is 11,799 to three digits only if the engine computed it: it did not here");
  assert.deepEqual(check.verdicts.map((verdict) => [verdict.warning, verdict.verdict]), [[true, "unsupported"], [true, "unsupported"]]);
  assert.match(check.verdicts[0].reason, /^这个数没有在本研究的计算结果里找到：11,800$/);
  assert.match(check.verdicts[1].reason, /93\.1%/);
  assert.equal(check.verdicts[1].by, "vcr-results");
  assert.equal(check.counts.unsupported, 2);
  const stored = (await database.query("SELECT study_id, model, cost FROM evimed_review.reply_checks WHERE run_id=$1 AND user_id=$2", ["run_vcr_1", userId])).rows[0];
  assert.equal(stored.study_id, "std_1");
  assert.equal(stored.model, "qwen3.8-max-0902");
  assert.ok(Number(stored.cost) > 0, "the call is booked against the run");
});

test("a reply whose computed numbers are all the engine's is checked and says nothing; one with no number, or in no study, is never queued", options, async () => {
  const { review } = service(() => reviewerAnswer({ claims: [{ sentence: 0, numbers: ["845", "91.5%"] }] }));
  const identity = { userId, projectId };
  assert.ok(await review.considerReply(identity, { id: "run_vcr_2", sessionId: "chat-vcr-2" }, { replyText: "845 例事件，功效 91.5%。", turnSeq: 1 }, { studyId: "std_1" }));
  await review.processReplyChecks("worker-vcr");
  const [check] = await review.replyChecksForSession(identity, "chat-vcr-2");
  assert.deepEqual([check.status, check.verdicts], ["done", []]);
  assert.equal(await review.considerReply(identity, { id: "run_vcr_3", sessionId: "chat-vcr-3" }, { replyText: "先看你的研究问题是什么。" }, { studyId: "std_1" }), null, "no number: nothing to check");
  assert.equal(await review.considerReply(identity, { id: "run_vcr_4", sessionId: "chat-vcr-4" }, { replyText: "845 例事件，功效 91.5%。" }), null, "an ordinary conversation is not checked against a study");
  const unwired = new ReviewService({ config, database, usageLedger: new UsageLedger(database), store: { userById: async () => ({ id: userId }), requireProject: async () => ({ id: projectId, userId }) } });
  assert.equal(await unwired.considerReply(identity, { id: "run_vcr_5", sessionId: "chat-vcr-5" }, { replyText: "845 例事件。" }, { studyId: "std_1" }), null, "no module, no check");
});

test("a reviewer that fails fails the check, which is tried again — the reply is never judged on a judgement that did not happen", options, async () => {
  let attempts = 0;
  const { review } = service(() => { attempts += 1; return attempts === 1 ? new Response("upstream error", { status: 500 }) : reviewerAnswer({ claims: [{ sentence: 0, numbers: ["850"] }] }); });
  const identity = { userId, projectId };
  assert.ok(await review.considerReply(identity, { id: "run_vcr_6", sessionId: "chat-vcr-6" }, { replyText: "需要 850 例事件。", turnSeq: 1 }, { studyId: "std_1" }));
  await review.processReplyChecks("worker-vcr");
  assert.equal((await review.replyChecksForSession(identity, "chat-vcr-6"))[0].status, "queued", "tried again, not failed");
  await review.processReplyChecks("worker-vcr");
  const [check] = await review.replyChecksForSession(identity, "chat-vcr-6");
  assert.equal(check.status, "done");
  assert.equal(check.verdicts.length, 1);
});
