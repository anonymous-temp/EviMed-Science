// The compaction A/B's own instrument (2026-10-25): the scripted conversation, what counts as having survived, the scoring, the rule that decides and the
// driver, against a stand-in kernel. No kernel, no key, no database. The numbers a real run produces are the controller's to read; these tests are that the
// instrument says what it was built to say.
import assert from "node:assert/strict";
import test from "node:test";

import { SOCKET_PLUGIN_SWITCHES } from "../../apps/server/src/dshProfilePatch.mjs";
import {
  ARMS, DECISION, DEFAULTS, FACTS, TASK_CHECKS, buildScenario, compactionsIn, decide, fillerTable, holds, render, runSample, scoreSample, summarizeArm,
} from "./compaction_ab_lib.mjs";
import { armEnvironment, main, parseArguments, scriptedKernel } from "./compaction_ab.mjs";

const ALL_FACTS_ANSWER = "规则：1) 血糖只用 mmol/L；2) 每一节最多三条要点；3) 文件放 out/ 目录。路径：out/q3-summary.md。编号：CASE-4471、BATCH-20261025-B。待办：核对 12 条记录。";
const GOOD_TASK_ANSWER = "空腹血糖 6.99 mmol/L（126 mg/dL 换算），这句话存到 out/q3-summary.md。";

/** @param {Partial<{ recall: string, task: string, compactions: number, code: number }>} [options] */
function sample({ recall = ALL_FACTS_ANWSER_PLACEHOLDER(), task = GOOD_TASK_ANSWER, compactions = 1, code = 0 } = {}, arm = "basic", id = `${arm}-1`, cost = 0.01) {
  return { id, arm, cost, requests: 8, error: null, turns: [
    { id: "t1", kind: "setup", text: "收到", compactions: 0, latencyMs: 1000, code },
    { id: "t2", kind: "filler", text: "第 7 行", compactions, latencyMs: 2000, code },
    { id: "t3", kind: "recall", text: recall, compactions: 0, latencyMs: 1500, code },
    { id: "t4", kind: "task", text: task, compactions: 0, latencyMs: 1500, code },
  ] };
}
function ALL_FACTS_ANWSER_PLACEHOLDER() { return ALL_FACTS_ANSWER; }

test("the scripted conversation states every fact in its first turns, fills the window with tables, and asks last", () => {
  const scenario = buildScenario();
  assert.deepEqual(scenario.turns.map((turn) => turn.kind), ["setup", "setup", ...Array(DEFAULTS.fillerTurns).fill("filler"), "recall", "task"]);
  const stated = scenario.turns.filter((turn) => turn.kind === "setup").map((turn) => turn.prompt).join("\n");
  for (const [name, spellings] of Object.entries(FACTS)) assert.ok(holds(stated, spellings), `${name} is said before the filler`);
  assert.ok(new Set(scenario.turns.map((turn) => turn.id)).size === scenario.turns.length, "unique turn ids");
  assert.ok(scenario.turns.filter((turn) => turn.kind === "filler").every((turn) => turn.prompt.length > 5000), "a table is a real block of pasted data");
  assert.ok(!scenario.turns.filter((turn) => turn.kind === "filler").some((turn) => holds(turn.prompt, FACTS.case_id)), "the filler repeats none of the facts: only the first turns carry them");
  assert.equal(fillerTable(3, 150), fillerTable(3, 150), "deterministic");
  assert.notEqual(fillerTable(3, 150), fillerTable(4, 150));
  assert.equal(buildScenario({ fillerTurns: 2, fillerRows: 10 }).turns.length, 6);
  assert.match(scenario.turns.at(-1).prompt, /126 mg\/dL/);
});

test("a fact is in an answer when one of its spellings is, whatever the white space and the case", () => {
  assert.equal(holds("请存到  OUT/Q3-Summary.md 里", ["out/q3-summary.md"]), true);
  assert.equal(holds("血糖用 mmol / L", ["mmol/L"]), true);
  assert.equal(holds("最多 3 条", FACTS.rule_bullets), true);
  assert.equal(holds("没有这些", FACTS.case_id), false);
  assert.equal(holds(null, FACTS.case_id), false);
});

test("a compaction is told by its end; a stream that names one without an end counts its starts; a stream of nothing recognisable is zero", () => {
  assert.equal(compactionsIn([{ type: "compaction/start" }, { type: "compaction/end" }, { type: "final" }]), 1);
  assert.equal(compactionsIn([{ type: "compaction/end" }, { type: "tool_call" }, { type: "compaction/end" }]), 2);
  assert.equal(compactionsIn([{ type: "compaction/start" }]), 1);
  assert.equal(compactionsIn([{ event: "context.compacted" }]), 1);
  assert.equal(compactionsIn([{ type: "session" }, { type: "final", text: "compaction" }]), 0, "words in an answer are not an event");
  assert.equal(compactionsIn([]), 0);
  assert.equal(compactionsIn([null, 1, "x"]), 0);
});

test("a sample is scored on what survived and whether the next answer is right, and only if the kernel compacted before the probes", () => {
  const full = scoreSample(sample());
  assert.deepEqual([full.valid, full.survivedFraction, full.missing, full.taskPassed, full.taskFraction], [true, 1, [], true, 1]);
  const partial = scoreSample(sample({ recall: "规则：血糖只用 mmol/L。编号：CASE-4471。" }));
  assert.deepEqual(partial.survived, ["rule_unit", "case_id"]);
  assert.ok(Math.abs(/** @type {number} */ (partial.survivedFraction) - 2 / Object.keys(FACTS).length) < 1e-9);
  assert.deepEqual(partial.missing, ["rule_bullets", "rule_directory", "path", "batch_id", "open_item"]);
  const wrong = scoreSample(sample({ task: "空腹血糖 126 mg/dL，存到 report.md。" }));
  assert.deepEqual([wrong.task.converted, wrong.task.unit, wrong.task.file, wrong.taskPassed], [false, false, false, false]);
  const unit = scoreSample(sample({ task: "约 7 mmol/L，存到别处。" }));
  assert.deepEqual([unit.task.converted, unit.task.unit, unit.task.file, unit.taskPassed], [true, true, false, false]);
  assert.equal(Object.keys(TASK_CHECKS).length, 3);

  const never = scoreSample(sample({ compactions: 0 }));
  assert.deepEqual([never.valid, never.survivedFraction, never.taskPassed], [false, null, null]);
  assert.match(String(never.why), /never compacted/);
  const failed = scoreSample(sample({ code: 1 }));
  assert.equal(failed.valid, false);
  assert.equal(scoreSample({ ...sample(), error: "t2: timed out" }).why, "t2: timed out");
  assert.equal(scoreSample({ id: "x", arm: "basic", turns: [], cost: 0, requests: 0 }).valid, false);
  assert.equal(full.latencyMs, 6000);
  assert.equal(full.compactions, 1, "a compaction during the probes does not count toward having compacted before them");
  // A compaction during the probes is not one before them: the probes would have read the history whole.
  const late = sample({ compactions: 0 });
  late.turns = late.turns.map((turn) => (turn.kind === "recall" ? { ...turn, compactions: 2 } : turn));
  assert.equal(scoreSample(late).valid, false);
});

/** @param {string} arm @param {number} valid @param {{ survive: number, task?: boolean, cost?: number }} shape @param {number} [invalid] */
function arm(name, valid, { survive, task = true, cost = 0.01 }, invalid = 0) {
  const facts = Object.keys(FACTS);
  const kept = facts.slice(0, Math.round(survive * facts.length));
  const recall = ALL_FACTS_ANSWER.length && kept.map((fact) => FACTS[fact][0]).join(" ");
  const rows = Array.from({ length: valid }, (_, index) => scoreSample(sample({ recall, task: task ? GOOD_TASK_ANSWER : "不知道" }, name, `${name}-${index}`, cost)));
  for (let index = 0; index < invalid; index += 1) rows.push(scoreSample(sample({ compactions: 0 }, name, `${name}-x${index}`, cost)));
  return summarizeArm(rows);
}

test("an arm is summarised over its valid samples for survival and the next answer, and over every sample for cost and time", () => {
  const summary = arm("basic", 3, { survive: 4 / 7, cost: 0.02 }, 1);
  assert.deepEqual([summary.samples, summary.valid, summary.invalid.length], [4, 3, 1]);
  assert.equal(summary.survival.mean, round(4 / 7));
  assert.deepEqual(summary.nextAnswer, { passed: 3, of: 3, rate: 1 });
  assert.deepEqual(summary.lostMost.map((entry) => entry.fact), ["case_id", "batch_id", "open_item"].filter((fact) => Object.keys(FACTS).indexOf(fact) >= 4).sort((a, b) => Object.keys(FACTS).indexOf(a) - Object.keys(FACTS).indexOf(b)));
  assert.equal(summary.cost.requests, 32);
  assert.equal(summary.cost.total, 0.08);
  assert.equal(summary.cost.mean, 0.02);
});
/** @param {number} value */
function round(value) { return Math.round(value * 1e4) / 1e4; }

test("the rule: structured is switched on only by a gap of fifteen points over three valid samples of each and no worse next answer; a gap under five, or a worse next answer, deletes it; the rest is inconclusive", () => {
  assert.deepEqual([DECISION.minValidPerArm, DECISION.minGap, DECISION.noGain], [3, 0.15, 0.05]);
  const basic = arm("basic", 3, { survive: 3 / 7 });
  const better = decide({ basic, structured: arm("structured", 3, { survive: 7 / 7 }) });
  assert.equal(better.verdict, "structured");
  assert.match(better.action, /make `structured` the default of OPEN_SCIENCE_RUNTIME_COMPACTION_POLICY/);
  assert.equal(better.gap, round(1 - 3 / 7));

  assert.equal(decide({ basic, structured: arm("structured", 3, { survive: 3 / 7 }) }).verdict, "basic", "no gain");
  const same = decide({ basic, structured: arm("structured", 3, { survive: 3 / 7 }) });
  assert.match(same.action, /delete `structured`/);
  assert.equal(decide({ basic, structured: arm("structured", 3, { survive: 2 / 7 }) }).verdict, "basic", "worse");
  const worseTask = decide({ basic, structured: arm("structured", 3, { survive: 7 / 7, task: false }) });
  assert.equal(worseTask.verdict, "basic", "keeps more and answers worse: the next answer is the thing it is for");
  assert.match(worseTask.reason, /answered the next task worse/);
  const between = decide({ basic, structured: arm("structured", 3, { survive: 4 / 7 }) });
  assert.equal(between.verdict, "inconclusive");
  assert.match(between.reason, /between the 5 that is no gain and the 15 that is a win/);

  const fewer = decide({ basic, structured: arm("structured", 3, { survive: 7 / 7 }, 0) });
  assert.equal(fewer.verdict, "structured");
  const thin = decide({ basic: arm("basic", 2, { survive: 3 / 7 }, 2), structured: arm("structured", 3, { survive: 7 / 7 }) });
  assert.equal(thin.verdict, "inconclusive", "an arm that mostly did not compact says nothing");
  assert.match(thin.reason, /at least 3 valid samples/);
  assert.equal(thin.gap, null);
});

test("the driver runs the conversation turn by turn in one session, reads the cost of the sample, and stops at a turn that failed", async () => {
  /** @type {any[]} */ const asked = [];
  const native = async (/** @type {any} */ request) => { asked.push(request); return { code: 0, events: [], latencyMs: 5, sessionId: "s1", text: "ok" }; };
  const meter = { begin: (/** @type {string} */ id) => asked.push({ began: id }), end: async () => ({ cost: 0.5, requests: 3 }) };
  const scenario = buildScenario({ fillerTurns: 1, fillerRows: 5 });
  const done = await runSample({ native, scenario, arm: "basic", id: "basic-1", meter });
  assert.equal(done.turns.length, scenario.turns.length);
  assert.deepEqual([done.cost, done.requests, done.error], [0.5, 3, null]);
  assert.deepEqual(asked.slice(0, 3).map((entry) => entry.began ?? [entry.sessionId, entry.filename]), ["basic-1", [null, "basic-1-01-rules"], ["s1", "basic-1-02-open"]], "the first turn opens the session and the rest resume it");

  const failing = async (/** @type {any} */ request) => (request.filename.includes("table") ? { code: 1, events: [], latencyMs: 1, sessionId: "s1", text: "" } : { code: 0, events: [], latencyMs: 1, sessionId: "s1", text: "ok" });
  const cut = await runSample({ native: failing, scenario, arm: "structured", id: "structured-1" });
  assert.match(String(cut.error), /exited with 1/);
  assert.equal(cut.turns.length, 3, "nothing after the failed turn was run");
  assert.equal(scoreSample(cut).valid, false);
  const timedOut = await runSample({ native: async () => ({ code: 0, timedOut: true, events: [], latencyMs: 9, sessionId: null, text: "" }), scenario, arm: "basic", id: "t" });
  assert.match(String(timedOut.error), /timed out/);
  const thrown = await runSample({ native: async () => { throw new Error("spawn failed"); }, scenario, arm: "basic", id: "t2" });
  assert.match(String(thrown.error), /spawn failed/);
});

test("the two arms differ in one environment variable: the policy; every other switchable socket plugin is off for both", () => {
  const setup = { thresholdRatio: 0.8 };
  const basic = armEnvironment("basic", setup, SOCKET_PLUGIN_SWITCHES);
  const structured = armEnvironment("structured", setup, SOCKET_PLUGIN_SWITCHES);
  const differing = Object.keys(structured).filter((key) => structured[key] !== basic[key]);
  assert.deepEqual(differing, ["EVIMED_COMPACTION_POLICY"]);
  assert.deepEqual([basic.EVIMED_COMPACTION_POLICY, structured.EVIMED_COMPACTION_POLICY, structured.EVIMED_COMPACTION_ENABLED, structured.EVIMED_COMPACTION_THRESHOLD_RATIO], ["basic", "structured", "1", "0.8"]);
  for (const [plugin, variable] of Object.entries(SOCKET_PLUGIN_SWITCHES)) if (plugin !== "evimed-compaction") assert.equal(structured[variable], "0", `${plugin} is off`);
  assert.throws(() => armEnvironment("loud", setup, SOCKET_PLUGIN_SWITCHES), /Unknown arm/);
});

test("the arguments are bounded, a real run names what it needs, and a bare kernel is refused", async () => {
  assert.deepEqual([parseArguments([]).samples, parseArguments([]).contextWindow, parseArguments(["--samples", "5", "--context-window", "12000"]).samples], [3, 20000, 5]);
  assert.throws(() => parseArguments(["--samples", "0"]), /--samples/);
  assert.throws(() => parseArguments(["--samples", "13"]), /between 1 and 12/);
  assert.throws(() => parseArguments(["--context-window", "lots"]), /positive number/);
  await assert.rejects(() => main(["--out", "/tmp/x"]), /Required: --dsh/);
  await assert.rejects(() => main(["--dsh", "dsh", "--dump", "d", "--key-file", "k", "--postgres", "p", "--out", "/tmp/x"]), /A seeded profile is required/);
});

test("the whole driver against the stand-in kernel: both arms, interleaved, scored, decided and rendered", async () => {
  const lines = /** @type {string[]} */ ([]);
  const log = console.log;
  const error = console.error;
  console.log = (/** @type {string} */ line) => lines.push(String(line));
  console.error = () => {};
  try {
    const result = /** @type {any} */ (await main(["--dry-run", "--samples", "3"]));
    assert.equal(result.arms.basic.samples, 3);
    assert.equal(result.arms.structured.valid, 3, "the stand-in compacts: every sample is valid");
    assert.equal(result.decision.verdict, "structured", "it keeps the facts across the fold in one arm only, which is what the rule must see");
    assert.match(result.report, /Compaction A\/B: window 20000 tokens, pressure at 80%, 3 samples per arm/);
    assert.match(result.report, /Verdict: structured/);
    assert.equal(lines.at(-1), result.report);
  } finally {
    console.log = log;
    console.error = error;
  }
  assert.deepEqual(ARMS, ["basic", "structured"]);
  const kernel = scriptedKernel("basic", { contextWindow: 20000, thresholdRatio: 0.8 });
  assert.equal((await kernel({ prompt: "x".repeat(60_000), sessionId: null })).events.some((event) => event.type === "compaction/end"), true);
  assert.match(render({ basic: arm("basic", 3, { survive: 1 }), structured: arm("structured", 3, { survive: 1 }) }, decide({ basic: arm("basic", 3, { survive: 1 }), structured: arm("structured", 3, { survive: 1 }) }), { contextWindow: 20000, thresholdRatio: 0.8, samples: 3 }), /Do: delete `structured`/);
});
