// The recognition of a removed line in other words (2026-10-23, rectification T1.9 / D8): what is decided in code (a line that contains
// it), what is put to the model (a line that is only near it) and what the code checks of the model's answer.
import assert from "node:assert/strict";
import test from "node:test";

import { MIN_CONTAINED, SIMILAR, compact, containsRemoved, createRejectionJudge, judgeRequestBody, nearRemoved, parseJudgement, similarity } from "../src/nativeMemoryRejections.mjs";
import { nativeMemoryCounters, resetNativeMemoryMetrics } from "../src/nativeMemoryMetrics.mjs";

const removed = (text, fingerprint = text.slice(0, 1).repeat(64)) => ({ fingerprint, text });

test("a line that contains a removed line's words is it with something added; a short removed line is met only by an exact repeat", () => {
  assert.equal(compact("  Cites, with  Numbered references! (as of 2026-10-01)  ").includes("citeswithnumberedreferences"), true);
  assert.equal(containsRemoved("Cites with numbered references; DOIs always.", "cites with numbered references."), true, "case, spacing and punctuation do not make two wordings");
  assert.equal(containsRemoved("- 我喜欢用表格比较，而且每次都给出处。", "用表格比较"), false, `a removed line under ${MIN_CONTAINED} characters is too common a phrase to forbid every line that holds it`);
  assert.equal(containsRemoved("先给结论，再给依据，最后列出风险。", "先给结论，再给依据"), true);
  assert.equal(containsRemoved("Prefers short answers.", "answers in short paragraphs"), false);
  assert.equal(containsRemoved("anything", ""), false);
});

test("the prefilter is cheap and wide: paraphrases are near, unrelated lines are not, and the model decides", () => {
  assert.ok(similarity("Prefers tables for comparisons.", "Likes comparisons presented as tables") >= SIMILAR);
  assert.ok(similarity("每次先给结论，再给依据。", "回答先给出结论，然后是依据") >= SIMILAR);
  assert.ok(similarity("Works as a clinical pharmacist.", "Prefers tables for comparisons.") < SIMILAR);
  assert.equal(similarity("ab", "abcd"), 0, "too short to compare");
  const near = nearRemoved("Prefers tables when comparing options", [removed("prefers tables for comparisons"), removed("works as a clinical pharmacist"), { fingerprint: "f".repeat(64), text: null }]);
  assert.deepEqual(near.map((line) => line.text), ["prefers tables for comparisons"], "a rejection with no words is not compared");
  const many = Array.from({ length: 6 }, (_, index) => removed(`prefers tables for comparisons number ${index}`, String(index).repeat(64)));
  assert.equal(nearRemoved("Prefers tables for comparisons", many).length, 3, "at most three removed lines are offered for one line");
});

test("what the model said stands only as far as the code can check it", () => {
  const candidates = [{ options: [0, 1] }, { options: [1] }, { options: [2] }];
  const judged = parseJudgement(JSON.stringify({ same: [
    { candidate: 0, removed: 1 }, { candidate: 0, removed: 0 }, // one pair per candidate: the first
    { candidate: 1, removed: 0 },                                // a pair that was not offered
    { candidate: 2, removed: 9 }, { candidate: 7, removed: 0 },  // an index that does not exist
    { candidate: "1", removed: 1 }, null, "x",                    // not the one shape
  ], stated: [2, 9, "0", -1] }), candidates, 3);
  assert.deepEqual([...judged.same], [[0, 1]]);
  assert.deepEqual([...judged.stated], [2]);
  assert.equal(parseJudgement("not json", candidates, 3), null);
  assert.equal(parseJudgement(JSON.stringify({ same: "yes" }), candidates, 3), null);
  assert.equal(parseJudgement(JSON.stringify([]), candidates, 3), null);
  assert.deepEqual([...parseJudgement(JSON.stringify({ same: [] }), candidates, 3).same], []);
});

/** A judge over a stubbed model: what it was asked, and one answer per call. */
function judgeWith(answers, config = {}) {
  resetNativeMemoryMetrics();
  /** @type {any[]} */ const calls = [];
  let n = 0;
  const judge = createRejectionJudge({
    config: { deepseekProviderEnabled: true, deepseekApiKey: "k", deepseekModel: "deepseek-v4-flash", nativeMemoryRejectionJudgeDailyCalls: 2, ...config },
    now: () => new Date("2026-10-23T09:00:00.000Z"),
    callModel: async (_deps, call) => {
      calls.push(call);
      const answer = answers[Math.min(n++, answers.length - 1)];
      if (answer instanceof Error) throw answer;
      return { choices: [{ message: { content: typeof answer === "string" ? answer : JSON.stringify(answer) } }] };
    },
  });
  return { judge, calls };
}
const request = (over = {}) => ({ userId: "u1", projectId: "p1", candidates: [
  { text: "Prefers tables when comparing options", removed: [removed("prefers tables for comparisons", "a".repeat(64))] },
  { text: "Writes in british english", removed: [removed("uses british spelling", "b".repeat(64)), removed("prefers tables for comparisons", "a".repeat(64))] },
], said: ["Use tables when I ask you to compare."], ...over });

test("one call carries a commit's near lines, thinking off, charged as memory extraction, and its answer is mapped back to the removed lines", async () => {
  const { judge, calls } = judgeWith([{ same: [{ candidate: 0, removed: 0 }, { candidate: 1, removed: 1 }], stated: [0] }]);
  const answer = await judge.same(request());
  assert.equal(calls.length, 1, "one call for both lines");
  const [call] = calls;
  assert.equal(call.purpose, "memory-extraction");
  assert.equal(call.projectId, "p1");
  assert.equal(call.userId, "u1");
  assert.deepEqual(call.body.thinking, { type: "disabled" });
  assert.equal(call.body.temperature, 0);
  assert.equal(call.body.response_format.type, "json_object");
  const shown = JSON.parse(call.body.messages[1].content);
  assert.equal(shown.removed.length, 2, "a removed line two candidates are near is shown once");
  assert.deepEqual(shown.candidates.map((candidate) => candidate.options), [[0], [1, 0]]);
  assert.deepEqual(shown.said, ["Use tables when I ask you to compare."]);
  // Mapped back to the fingerprints, and the person's own are marked.
  assert.deepEqual([...answer.same], [[0, "a".repeat(64)], [1, "b".repeat(64)]]);
  assert.deepEqual([...answer.stated], [0]);
  assert.equal(nativeMemoryCounters().rejectionJudge.asked, 1);
  assert.equal(nativeMemoryCounters().rejectionLines.judged_same, 2);
  assert.equal(judgeRequestBody("m", { candidates: [], removed: [], said: [] }).max_tokens, 600);
});

test("a judge that cannot answer keeps the line: unreachable, not the one shape, over the account's day, or no model here", async () => {
  const failing = judgeWith([new Error("model gateway down")]);
  const first = await failing.judge.same(request());
  assert.deepEqual([first.same.size, first.stated.size], [0, 0]);
  assert.equal(nativeMemoryCounters().rejectionJudge.failed, 1);
  assert.equal(nativeMemoryCounters().rejectionLines.judge_failed, 2);

  const garbled = judgeWith(["I think they are the same"]);
  assert.equal((await garbled.judge.same(request())).same.size, 0);
  assert.equal(nativeMemoryCounters().rejectionJudge.failed, 1);

  // Two calls a day: the third is refused without asking, and the next day is a new day (the clock is fixed here, so a new judge).
  const bounded = judgeWith([{ same: [] }]);
  await bounded.judge.same(request());
  await bounded.judge.same(request());
  assert.equal((await bounded.judge.same(request())).same.size, 0);
  assert.equal(bounded.calls.length, 2);
  assert.equal(nativeMemoryCounters().rejectionJudge.over_budget, 1);
  assert.equal((await bounded.judge.same(request({ userId: "u2" }))).same.size, 0, "another account has its own day");
  assert.equal(bounded.calls.length, 3);

  const off = judgeWith([{ same: [] }], { nativeMemoryRejectionJudgeEnabled: false });
  assert.equal(off.judge.available, false);
  assert.equal((await off.judge.same(request())).same.size, 0);
  assert.equal(off.calls.length, 0);
  assert.equal(nativeMemoryCounters().rejectionJudge.unavailable, 1);
  const keyless = judgeWith([{ same: [] }], { deepseekApiKey: "" });
  assert.equal(keyless.judge.available, false);
  // Nothing to ask is no call.
  const idle = judgeWith([{ same: [] }]);
  await idle.judge.same(request({ candidates: [] }));
  assert.equal(idle.calls.length, 0);
});

test("a commit with more near lines than one call carries is asked about the first eight, and the rest are kept", async () => {
  const { judge, calls } = judgeWith([{ same: [{ candidate: 0, removed: 0 }] }]);
  const candidates = Array.from({ length: 12 }, (_, index) => ({ text: `Prefers tables number ${index}`, removed: [removed("prefers tables for comparisons", "a".repeat(64))] }));
  const answer = await judge.same({ userId: "u1", candidates });
  assert.equal(JSON.parse(calls[0].body.messages[1].content).candidates.length, 8);
  assert.equal(calls[0].projectId, "default", "no project: the account's own");
  assert.deepEqual([...answer.same.keys()], [0]);
});
