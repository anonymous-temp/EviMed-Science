// The follow-up judge's calibration instrument: the case file, the scoring and the runner with a stubbed model. No network, no key.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { LEARNING_EVIDENCE_VERDICTS } from "@evimed/domain";
import { FOLLOW_UP_JUDGE_INSTRUCTIONS, FollowUpJudge, followUpVerdictFrom } from "../../../apps/server/src/learningEvidence.mjs";
import { main, parseArguments, rawVerdictOf, runCases } from "../run.mjs";
import { CLASSES, adoptReport, caseIssues, concernReport, confusion, isRight, perClass, quoteReport, render, summarize } from "../score.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const { cases } = JSON.parse(await readFile(path.join(here, "../cases.json"), "utf8"));
const byMessage = (message, previous = undefined) => cases.find((item) => item.message === message && (previous === undefined || item.previousRequest === previous));

test("the case file is shaped: unique ids, quotations that are substrings, an ambiguity says why", () => {
  assert.deepEqual(caseIssues(cases), []);
  assert.ok(cases.length >= 110 && cases.length <= 140, `${cases.length} cases`);
});

test("the classes and the languages are spread as the brief asks", () => {
  const count = (key, value) => cases.filter((item) => item[key] === value).length;
  for (const cls of CLASSES) assert.ok(count("class", cls) >= 10, `${cls}: ${count("class", cls)}`);
  assert.ok(count("class", "adopt") >= 20, "adopt is the class whose precision matters most");
  const chinese = count("lang", "zh") / cases.length;
  assert.ok(chinese >= 0.65 && chinese <= 0.75, `${Math.round(chinese * 100)}% Chinese`);
  assert.ok(cases.filter((item) => item.ambiguous).length >= 8, "the controller reviews the cases the labeller hesitated over");
  assert.ok(cases.every((item) => !item.ambiguous || item.why), "every ambiguity says why");
});

test("the near misses that matter most are in, with the labels the brief gives them", () => {
  const expected = [
    ["这次就这样吧。", "accept"], ["好的谢谢", "accept"], ["记住我喜欢短的。", "preference"], ["格式就按这个，内容再补两条", "correction"],
    ["顺便帮我查一下阿司匹林的半衰期。", "none"], ["太长了", "correction"], ["短点", "correction"], ["以后周报都按这个来。", "adopt"],
    ["这个格式很好，以后周报都按这个来。", "adopt"], ["把刚才的做法存下来，以后写这类东西都这样。", "adopt"], ["From now on, do it like this.", "adopt"],
  ];
  for (const [message, cls] of expected) {
    const item = byMessage(message);
    assert.ok(item, `${message} is a case`);
    assert.equal(item.class, cls, message);
  }
  assert.ok(cases.some((item) => item.tag === "sarcasm" && item.class === "correction"), "a sarcastic complaint");
  assert.ok(cases.some((item) => item.tag === "quotes-the-deliverable"), "a message that quotes the deliverable");
  assert.ok(cases.some((item) => item.tag?.startsWith("mixed")), "a mixed message");
  assert.ok(cases.filter((item) => item.methodsOpened).length >= 4, "cases where the run opened a learned method");
});

test("a malformed case is reported by name", () => {
  const base = cases.find((item) => item.class === "correction" && item.quote);
  const issues = (patch) => caseIssues([{ ...base, ...patch }]).join("\n");
  assert.match(issues({ class: "praise" }), /is not one of/);
  assert.match(issues({ quote: "not in the message" }), /not a substring/);
  assert.match(issues({ quote: null }), /carries the gold quotation/);
  assert.match(issues({ ambiguous: true }), /says why/);
  assert.match(issues({ alsoAcceptable: ["preference"] }), /is a hesitation/);
  assert.match(issues({ alsoAcceptable: ["correction"], ambiguous: true, why: "x" }), /not another class/);
  assert.match(issues({ concerns: ["m9"], methodsOpened: [] }), /not a method the run opened/);
  assert.match(caseIssues([base, base]).join("\n"), /repeated/);
  const accept = cases.find((item) => item.class === "accept");
  assert.match(caseIssues([{ ...accept, quote: "x" }]).join("\n"), /carries no quotation/);
});

/** A result as the runner makes it. */
const result = (id, gold, predicted, extra = {}) => ({ id, lang: "zh", gold, alsoAcceptable: [], ambiguous: false, predicted, failure: null, rawVerdict: predicted, quote: null, goldQuote: null, concerns: [], goldConcerns: null, ...extra });

test("precision and recall per class, and the confusion matrix, count what the module made of the answer", () => {
  const results = [
    result("a", "adopt", "adopt"), result("b", "accept", "adopt", { tag: "near-miss:accept-not-adopt" }), result("c", "adopt", "preference"), result("d", "preference", "preference"),
    result("e", "none", "unreadable", { failure: "judge_unreadable" }), result("f", "accept", "accept"),
  ];
  const matrix = confusion(results);
  assert.equal(matrix.adopt.adopt, 1);
  assert.equal(matrix.adopt.preference, 1);
  assert.equal(matrix.accept.adopt, 1);
  assert.equal(matrix.none.unreadable, 1);
  const classes = perClass(results);
  assert.deepEqual([classes.adopt.precision, classes.adopt.recall], [0.5, 0.5]);
  assert.deepEqual([classes.preference.precision, classes.preference.recall], [0.5, 1]);
  assert.equal(classes.none.recall, 0);
  assert.equal(classes.correction.precision, null, "nothing predicted: no precision, not zero");
});

test("adopt is reported on its own: precision strict and with the labels' second choices, recall, the false and the missed", () => {
  const results = [
    result("a", "adopt", "adopt"), result("b", "accept", "adopt", { tag: "near-miss:accept-not-adopt" }),
    result("c", "preference", "adopt", { alsoAcceptable: ["adopt"], ambiguous: true }), result("d", "adopt", "none"),
  ];
  const report = adoptReport(results);
  assert.deepEqual([report.predicted, report.correct, report.precision, report.precisionLenient, report.recall], [3, 1, 0.333, 0.667, 0.5]);
  assert.deepEqual(report.falseAdopts, [{ id: "b", gold: "accept", tag: "near-miss:accept-not-adopt" }]);
  assert.deepEqual(report.missedAdopts, [{ id: "d", predicted: "none" }]);
  assert.equal(adoptReport([result("z", "none", "none")]).precision, null);
});

test("a prediction the label allows counts only leniently", () => {
  const item = result("x", "correction", "preference", { alsoAcceptable: ["preference"], ambiguous: true });
  assert.equal(isRight(item), false);
  assert.equal(isRight(item, true), true);
});

test("quotations: the module's acceptance, and the overlap with the gold words", () => {
  const results = [
    result("a", "correction", "correction", { quote: "太长了", goldQuote: "太长了，每条不要超过二十个字" }),
    result("b", "preference", "preference", { quote: "别的话", goldQuote: "记住我喜欢短的" }),
    result("c", "correction", "unreadable", { failure: "quote_not_found" }),
    result("d", "accept", "accept"),
  ];
  const report = quoteReport(results);
  assert.deepEqual([report.carrying, report.accepted, report.quoteNotFound, report.overlapsGold], [3, 2, 1, 1]);
  assert.equal(report.validRate, 0.667);
  assert.equal(report.overlapRate, 0.5);
});

test("the methods a verdict names are compared as sets", () => {
  const report = concernReport([
    result("a", "correction", "correction", { concerns: ["m1"], goldConcerns: ["m1"] }), result("b", "accept", "accept", { concerns: [], goldConcerns: [] }),
    result("c", "none", "none", { concerns: ["m1"], goldConcerns: [] }), result("d", "none", "none"),
  ]);
  assert.deepEqual([report.cases, report.exact], [3, 2]);
  assert.deepEqual(report.wrong, [{ id: "c", said: ["m1"], gold: [] }]);
});

test("the summary leaves model failures out of the rates, keeps the module's refusals, and renders", () => {
  const results = [result("a", "accept", "accept"), result("b", "none", "unreadable", { failure: "model_failed" }), result("c", "none", "unreadable", { failure: "quote_not_found" })];
  const summary = summarize(results);
  assert.equal(summary.modelFailed, 1);
  assert.equal(summary.accuracy, 0.5);
  assert.deepEqual(summary.failures, { model_failed: 1, quote_not_found: 1 });
  const text = render(summary);
  assert.match(text, /adopt: predicted 0/);
  assert.match(text, /confusion/);
  assert.match(text, /wrong \(even leniently\): c none→unreadable/);
});

/** A stub of the model call that records what the module sent and answers by the message. */
function stubJudge(answerFor, seen = []) {
  const callModel = async (_context, call) => {
    seen.push(call.body);
    const message = JSON.parse(call.body.messages[1].content).message;
    const answer = answerFor(message, call.body);
    if (answer === null) throw new Error("the model is down");
    return { choices: [{ message: { content: typeof answer === "string" ? answer : JSON.stringify(answer) } }] };
  };
  return new FollowUpJudge({ deepseekProviderEnabled: true, deepseekApiKey: "stub", deepseekModel: "deepseek-flash" }, { callModel });
}

test("the runner sends the module's own request and reads the answer with the module's own parser", async () => {
  const subset = ["太长了", "这次就这样吧。", "记住我喜欢短的。", "顺便帮我查一下阿司匹林的半衰期。"].map((message) => byMessage(message));
  const seen = [];
  const judge = stubJudge((message) => {
    if (message === "太长了") return { verdict: "correction", rule: "回复要短", quote: "太长了", concerns: [] };
    if (message === "这次就这样吧。") return { verdict: "accept", rule: null, quote: null, concerns: [] };
    if (message === "记住我喜欢短的。") return { verdict: "preference", rule: "喜欢短的回复", quote: "不在消息里的话", concerns: [] };
    return null;
  }, seen);
  const results = await runCases({ cases: subset, judge, followUpVerdictFrom, concurrency: 2 });
  assert.deepEqual(results.map((item) => [item.predicted, item.failure]), [["correction", null], ["accept", null], ["unreadable", "quote_not_found"], ["unreadable", "model_failed"]]);
  assert.equal(results[0].quote, "太长了");
  assert.equal(seen.length, 4);
  for (const body of seen) {
    assert.equal(body.messages[0].content, FOLLOW_UP_JUDGE_INSTRUCTIONS, "the instructions are the module's");
    assert.deepEqual(Object.keys(JSON.parse(body.messages[1].content)).sort(), ["message", "methods", "previousRequest"]);
    assert.equal(body.thinking.type, "disabled");
  }
  const summary = summarize(results);
  assert.equal(summary.modelFailed, 1);
  assert.equal(summary.failures.quote_not_found, 1);
});

test("a verdict the tree does not know yet is unreadable, and the raw word the model chose is kept beside it", async () => {
  const item = byMessage("这个格式很好，以后周报都按这个来。");
  const judge = stubJudge(() => ({ verdict: "adopt", rule: "周报按这个格式写", quote: "以后周报都按这个来", concerns: [] }));
  const [one] = await runCases({ cases: [item], judge, followUpVerdictFrom });
  const known = LEARNING_EVIDENCE_VERDICTS.includes("adopt");
  assert.equal(one.predicted, known ? "adopt" : "unreadable");
  assert.equal(one.rawVerdict, "adopt");
  assert.equal(rawVerdictOf('{"verdict": "Adopt"}'), "adopt");
  assert.equal(rawVerdictOf("no verdict"), null);
});

test("methods the run opened are shown to the judge and an unknown id it names is dropped by the module", async () => {
  const item = cases.find((candidate) => candidate.methodsOpened && candidate.concerns?.length);
  const seen = [];
  const judge = stubJudge(() => ({ verdict: "correction", rule: "x", quote: item.quote, concerns: [...item.concerns, "lm-not-opened"] }), seen);
  const [one] = await runCases({ cases: [item], judge, followUpVerdictFrom });
  assert.deepEqual(one.concerns, item.concerns);
  assert.deepEqual(JSON.parse(seen[0].messages[1].content).methods.map((method) => method.id), item.methodsOpened.map((method) => method.id));
});

test("the arguments are read, and an unknown one is refused", () => {
  const options = parseArguments(["--key-file", "k", "--model", "m", "--only", "a,b", "--lang", "zh", "--concurrency", "99", "--samples", "2", "--dry-run"]);
  assert.deepEqual([options.keyFile, options.model, options.only, options.lang, options.concurrency, options.samples, options.dryRun], ["k", "m", ["a", "b"], "zh", 16, 2, true]);
  assert.throws(() => parseArguments(["--nope"]), /unknown argument/);
  assert.throws(() => parseArguments(["--key-file"]), /needs a value/);
});

test("the cases to review are listed with the labeller's reason", async () => {
  const lines = [];
  assert.equal(await main(["--list-ambiguous"], (text) => lines.push(text)), 0);
  const text = lines.join("");
  assert.equal((text.match(/why: /g) ?? []).length, cases.filter((item) => item.ambiguous).length);
  assert.match(text, /: 不对\n/);
});

test("a dry run prints the module's request and needs no key", async () => {
  const lines = [];
  assert.equal(await main(["--dry-run", "--only", "fj-001"], (text) => lines.push(text)), 0);
  const printed = JSON.parse(lines.join(""));
  assert.equal(printed.instructionsAreTheModules, true);
  assert.equal(printed.request.messages[0].content, FOLLOW_UP_JUDGE_INSTRUCTIONS);
});

test("the harness is registered in the acceptance ledger beside the other suites, and the row says what the case file says", async () => {
  const ledger = JSON.parse(await readFile(path.join(here, "../../acceptance-ledger.json"), "utf8"));
  const rows = ledger.suites.filter((row) => row.id === "follow-up-judge");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].evalHarness, "evals/follow-up-judge");
  assert.equal(rows[0].caseCount, cases.length);
  const kinds = {};
  for (const item of cases) kinds[item.class] = (kinds[item.class] ?? 0) + 1;
  assert.deepEqual(rows[0].kinds, Object.fromEntries(Object.entries(kinds).sort(([left], [right]) => left.localeCompare(right))));
});
