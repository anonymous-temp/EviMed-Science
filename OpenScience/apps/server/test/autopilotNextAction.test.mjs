import assert from "node:assert/strict";
import test from "node:test";
import { AUTOPILOT_TASK_TYPES } from "@evimed/domain";
import { AutopilotPlanner, PLANNER_INPUT_MAX_CHARS, PLANNER_STOP_KINDS, RESEARCHER_PAUSE_KIND, TASK_TYPE_SUMMARIES, buildPlannerContext,
  eligibleTaskTypes, parsePlannerAnswer, plannerInstructions, rotationTaskType } from "../src/autopilotNextAction.mjs";

const config = (extra = {}) => ({ deepseekProviderEnabled: true, deepseekApiKey: "k", deepseekModel: "deepseek-flash",
  userDailySpendLimit: 0, userWeeklySpendLimit: 0, ...extra });
const agenda = (extra = {}) => ({ id: "agenda-1", projectId: "project-1", payload: {
  title: "心衰证据追踪", prompt: "Track SGLT2 inhibitors in heart failure; preserve the original scope.", topics: ["SGLT2"],
  taskTypes: ["literature-sentinel", "evidence-update", "hypothesis-suggestion"], taskTypeState: {}, ...extra } });
const answer = (value) => ({ choices: [{ finish_reason: "stop", message: { content: typeof value === "string" ? value : JSON.stringify(value) } }] });
const run = { action: "run", taskType: "evidence-update", focus: "核对尚未复核的结论", reason: "上次的结论还没有独立复核" };

test("every task type the agenda can name has a summary the decision reads", () => {
  assert.deepEqual(Object.keys(TASK_TYPE_SUMMARIES).sort(), [...AUTOPILOT_TASK_TYPES].sort());
  for (const summary of Object.values(TASK_TYPE_SUMMARIES)) assert.ok(summary.length > 20);
});

test("a paused type is not offered, and the rotation covers the types that are", () => {
  const payload = agenda({ taskTypeState: { "literature-sentinel": { pausedAt: "2026-10-03T00:00:00Z" } } }).payload;
  assert.deepEqual(eligibleTaskTypes(payload), ["evidence-update", "hypothesis-suggestion"]);
  assert.deepEqual(eligibleTaskTypes({ taskTypes: ["evidence-update", "not-a-type"] }), ["evidence-update"], "only the closed vocabulary is a type");
  const eligible = ["evidence-update", "hypothesis-suggestion"];
  const days = ["2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"].map(date => rotationTaskType(eligible, date));
  assert.deepEqual(new Set(days), new Set(eligible));
  assert.notEqual(days[0], days[1]);
});

test("the context separates a run that did not happen from one that found nothing, and keeps negative results as results", () => {
  const progress = { truncated: false, followUps: [{ note: "Check the denominator", at: "2026-10-03T00:00:00Z", digestId: "d" }],
    rejectedDirections: [{ statement: "Beta blockers", note: "out of scope", claimId: "c" }],
    episodes: [
      { date: "2026-10-03", status: "failed", taskType: "literature-sentinel", focus: "核对分母", errorCode: "runtime_unavailable", claims: [], artifactRefs: [] },
      { date: "2026-10-02", status: "canceled", taskType: "literature-sentinel", claims: [], artifactRefs: [] },
      { date: "2026-10-01", status: "merged", taskType: "evidence-update", errorCode: null, artifactRefs: [{ path: "reports/synthesis.md" }], claims: [
        { statement: "Effect holds across subgroups", tier: "gated", refutation: "refuted", sources: ["a", "b"], verification: { status: "recorded" } },
        { statement: "No excess of ketoacidosis", tier: "gated", refutation: null, sources: ["a"], verification: { status: "unavailable" } },
        { statement: "Benefit is larger in HFpEF", tier: "unverified", refutation: null, sources: ["a"], verification: null }] },
      { date: "2026-09-30", status: "merged", taskType: "evidence-update", claims: [], artifactRefs: [] },
      { date: "2026-09-29", status: "running", taskType: "data-prospecting", claims: [], artifactRefs: [] }] };
  const context = buildPlannerContext({ agenda: agenda({ taskTypeState: { "literature-sentinel": { pausedAt: "x", consecutiveFailures: 2 } } }), progress,
    eligible: ["evidence-update", "hypothesis-suggestion"], date: "2026-10-04", trigger: "scheduled", reducedPriority: true, stopAllowed: true });
  assert.deepEqual(context.episodes.map(item => item.outcome), ["did_not_run", "canceled", "completed", "completed_without_claims", "in_progress"]);
  assert.equal(context.episodes[0].focus, "核对分母", "what the failed episode was set to look into is not lost with it");
  assert.equal(Object.hasOwn(context.episodes[1], "focus"), false);
  assert.equal(context.episodes[0].errorCode, "runtime_unavailable");
  assert.deepEqual(context.episodes[2].claims.map(item => item.independentCheck), ["refuted", "check_unavailable", "not_checked"]);
  assert.deepEqual(context.episodes[2].analyses, ["reports/synthesis.md"]);
  assert.equal(context.priority, "reduced");
  assert.equal(context.stopAllowed, true);
  const types = Object.fromEntries(context.taskTypes.map(item => [item.id, item]));
  assert.equal(types["literature-sentinel"].state, "paused_after_repeated_failures");
  assert.equal(types["literature-sentinel"].consecutiveFailures, 2);
  assert.equal(types["literature-sentinel"].lastEpisodeDate, "2026-10-03");
  assert.equal(types["evidence-update"].state, "available");
  assert.equal(types["evidence-update"].does, TASK_TYPE_SUMMARIES["evidence-update"]);
  assert.equal(context.openQuestions[0].note, "Check the denominator");
  assert.equal(context.rejectedDirections[0].statement, "Beta blockers");
  assert.match(context.question.instruction, /preserve the original scope/);
});

test("an over-long history drops its oldest episodes and never the question or the researcher's words", () => {
  const claim = index => ({ statement: `finding ${index} ${"x".repeat(550)}`, tier: "gated", refutation: null, sources: ["a"] });
  const progress = { followUps: [], rejectedDirections: [], truncated: false, episodes: Array.from({ length: 40 }, (_, index) => ({
    date: `2026-08-${String(1 + index).padStart(2, "0")}`, status: "merged", taskType: "evidence-update", claims: [claim(index), claim(index + 100), claim(index + 200)], artifactRefs: [] })) };
  const huge = { ...agenda().payload, prompt: "q".repeat(9_000) };
  const context = buildPlannerContext({ agenda: { id: "a", projectId: "p", payload: huge }, progress, eligible: ["evidence-update"], date: "2026-10-04",
    trigger: "follow-up", note: "n".repeat(9_000), reducedPriority: false, stopAllowed: false });
  assert.ok(context.question.instruction.length <= 2_000);
  assert.ok(context.request.note.length <= 1_500);
  assert.ok(JSON.stringify(context).length <= PLANNER_INPUT_MAX_CHARS + 2_000, "bounded by the cap and the fixed parts");
  assert.ok(context.episodes.length >= 1);
  assert.equal(context.progressTruncated, true);
  assert.equal(context.episodes[0].date, "2026-08-01", "the newest-first order is kept as it came");
});

test("the answer is held to the closed vocabulary and nothing nearby is accepted", () => {
  const options = { eligible: ["evidence-update", "hypothesis-suggestion"], stopAllowed: true };
  assert.deepEqual(parsePlannerAnswer(JSON.stringify(run), options), run);
  assert.deepEqual(parsePlannerAnswer("```json\n" + JSON.stringify(run) + "\n```", options), run);
  assert.deepEqual(parsePlannerAnswer(`Sure. ${JSON.stringify(run)}`, options), run, "an object inside prose is still the answer");
  assert.equal(parsePlannerAnswer(JSON.stringify({ ...run, focus: undefined }), options).focus, "", "a focus is optional");
  assert.equal(parsePlannerAnswer(JSON.stringify({ ...run, reason: `a\n\n  b ${"c".repeat(900)}` }), options).reason.length, 400);
  for (const bad of [
    "not json", "[]", JSON.stringify({ ...run, reason: "" }), JSON.stringify({ ...run, reason: undefined }),
    JSON.stringify({ ...run, taskType: "literature-sentinel" }),       // a real type, but paused: not offered
    JSON.stringify({ ...run, taskType: "Evidence-Update" }),           // not rounded to the nearest
    JSON.stringify({ ...run, action: "skip" }), JSON.stringify({ action: "stop", stopKind: "bored", reason: "x" }),
    JSON.stringify({ action: "stop", reason: "x" }),
  ]) assert.throws(() => parsePlannerAnswer(bad, options), { code: "autopilot_planner_invalid" }, bad);
  assert.throws(() => parsePlannerAnswer(JSON.stringify({ action: "stop", stopKind: "answered", reason: "done" }), { ...options, stopAllowed: false }),
    { code: "autopilot_planner_invalid" }, "a stop where none is allowed is dropped, not turned into a run");
  for (const stopKind of PLANNER_STOP_KINDS) {
    assert.deepEqual(parsePlannerAnswer(JSON.stringify({ action: "stop", stopKind, reason: "没有更多可做" }), { ...options, pauseAllowed: true }), { action: "stop", stopKind, reason: "没有更多可做" });
  }
});

test("a researcher's pause is the one stop their own message allows, and the scheduler's stops are not theirs to bring", () => {
  const pause = JSON.stringify({ action: "stop", stopKind: RESEARCHER_PAUSE_KIND, reason: "你要求先暂停" });
  const answered = JSON.stringify({ action: "stop", stopKind: "answered", reason: "已回答" });
  const base = { eligible: ["evidence-update"] };
  // Only where the message is the researcher's (a follow-up with a note): a scheduled occurrence cannot pause itself in their name.
  assert.deepEqual(parsePlannerAnswer(pause, { ...base, stopAllowed: false, pauseAllowed: true }), { action: "stop", stopKind: RESEARCHER_PAUSE_KIND, reason: "你要求先暂停" });
  assert.throws(() => parsePlannerAnswer(pause, { ...base, stopAllowed: true, pauseAllowed: false }), { code: "autopilot_planner_invalid" });
  assert.throws(() => parsePlannerAnswer(pause, { ...base, stopAllowed: true }), { code: "autopilot_planner_invalid" });
  // The other stops still need their own permission, whatever the message asked.
  assert.throws(() => parsePlannerAnswer(answered, { ...base, stopAllowed: false, pauseAllowed: true }), { code: "autopilot_planner_invalid" });
  assert.deepEqual(parsePlannerAnswer(answered, { ...base, stopAllowed: true, pauseAllowed: false }), { action: "stop", stopKind: "answered", reason: "已回答" });
});

test("the context carries the researcher's own words and files for this question and what the planner last stopped for, and nothing else", () => {
  const progress = { truncated: false, followUps: [], rejectedDirections: [], episodes: [],
    researcherNotes: [{ note: "分母应该是随机化人群，不是意向治疗人群", at: "2026-10-03T08:00:00Z" }],
    materials: [{ sourceId: "src_a", name: "年龄分布.xlsx", addedAt: "2026-10-04T01:00:00Z", state: "ready", path: ".evimed-knowledge/年龄分布.xlsx" },
      { sourceId: "src_b", name: "scan.pdf", addedAt: "2026-10-04T01:01:00Z", state: "reading" }],
    lastStop: { kind: "needs_input", reason: "需要受试者年龄分布", at: "2026-10-03T09:00:00Z" } };
  const context = buildPlannerContext({ agenda: agenda(), progress, eligible: ["evidence-update"], date: "2026-10-04", trigger: "follow-up",
    note: "先暂停一下", reducedPriority: false, stopAllowed: false, pauseAllowed: true });
  assert.deepEqual(context.researcherMessages, [{ note: "分母应该是随机化人群，不是意向治疗人群", at: "2026-10-03T08:00:00Z" }]);
  assert.deepEqual(context.materials.map(item => [item.name, item.state]), [["年龄分布.xlsx", "ready"], ["scan.pdf", "reading"]]);
  assert.equal(Object.hasOwn(context.materials[0], "sourceId"), false, "the decision reads the material, not our identifiers");
  assert.equal(context.earlierStop.kind, "needs_input");
  assert.equal(context.pauseAllowed, true);
  assert.equal(context.request.note, "先暂停一下");
  // A question with no history of its own reads none: the fields are absent, never another question's.
  const fresh = buildPlannerContext({ agenda: agenda(), progress: { episodes: [], followUps: [], rejectedDirections: [] }, eligible: ["evidence-update"],
    date: "2026-10-04", trigger: "scheduled", reducedPriority: false, stopAllowed: false });
  assert.deepEqual(["researcherMessages", "materials", "earlierStop", "pauseAllowed"].filter((field) => Object.hasOwn(fresh, field)), [], "nothing of another question, and no empty field in the prompt");
});

function planner(handler, extra = {}, options = {}) {
  const calls = [];
  const instance = new AutopilotPlanner(config(extra), { callModel: async (deps, call) => { calls.push({ deps, call }); return handler(call, calls.length); }, ...options });
  return { instance, calls };
}
const input = (extra = {}) => ({ userId: "user-1", projectId: "project-1", episodeId: "episode-abc", context: { today: "2026-10-04" },
  eligible: ["evidence-update", "hypothesis-suggestion"], stopAllowed: false, ...extra });

test("one metered, bounded call under its own purpose, charged to the episode it chooses for", async () => {
  const { instance, calls } = planner(async () => answer(run), { userDailySpendLimit: 30 });
  const decision = await instance.decide(input({ envelopeCny: 8 }));
  assert.deepEqual(decision, { ...run, model: "deepseek-flash" });
  assert.equal(calls.length, 1);
  const { call } = calls[0];
  assert.equal(call.purpose, "autopilot");
  assert.equal(call.userId, "user-1");
  assert.equal(call.projectId, "project-1");
  assert.equal(call.runId, "episode-abc");
  // Two different questions, two different sums (2026-10-04: the agenda's ¥3 a day was passed as `daily` and
  // compared with everything the account had spent): the account's caps over what the account spent, and the
  // episode's own envelope over what this one episode has spent, which is the decision itself.
  assert.deepEqual(call.limits, { daily: 30, weekly: 0, run: 8 });
  assert.equal(call.body.model, "deepseek-flash");
  assert.equal(call.body.max_tokens, 800, "an explicit ceiling, or the gateway reserves for 65,536 tokens");
  assert.deepEqual(call.body.thinking, { type: "disabled" });
  assert.deepEqual(call.body.response_format, { type: "json_object" });
  assert.equal(call.body.temperature, 0);
  assert.equal(call.body.messages[0].role, "system");
  assert.deepEqual(JSON.parse(call.body.messages[1].content), { today: "2026-10-04" });
  assert.ok(call.signal instanceof AbortSignal);
  assert.deepEqual(instance.counters, { decisions: 1, runs: 1, stops: 0, invalid: 0, failures: 0, circuitOpen: 0, budgetSpent: 0 });
  // An agenda's own daily and weekly caps are not a parameter of the decision at all: passed as `limits` they are ignored
  // rather than compared with the account's whole spend, and the account's caps stand as the deployment set them.
  const tighter = planner(async () => answer(run), { userDailySpendLimit: 5, userWeeklySpendLimit: 40 });
  await tighter.instance.decide(input({ limits: { daily: 3, weekly: 6 } }));
  assert.deepEqual(tighter.calls[0].call.limits, { daily: 5, weekly: 40, run: 0 }, "no envelope is no per-run cap, and the agenda's caps never become the account's");
});

test("a stop is returned as a stop with its kind, only where one is allowed", async () => {
  const stop = { action: "stop", stopKind: "needs_input", reason: "需要研究者提供原始数据" };
  const { instance } = planner(async () => answer(stop));
  assert.deepEqual(await instance.decide(input({ stopAllowed: true })), { ...stop, model: "deepseek-flash" });
  await assert.rejects(() => instance.decide(input({ stopAllowed: false })), { code: "autopilot_planner_invalid" });
  assert.equal(instance.counters.stops, 1);
  assert.equal(instance.counters.invalid, 1);
});

test("the decision is told about the researcher's words, files and pause only when the data has them", () => {
  const plain = plannerInstructions({ today: "2026-10-04", stopAllowed: true });
  for (const absent of ["researcherMessages", "materials", "earlierStop", "pauseAllowed", "paused_by_researcher"]) assert.equal(plain.includes(absent), false, `${absent} is not in a decision that has none`);
  assert.match(plain, /"stopKind":"answered"\|"exhausted"\|"needs_input"\}/, "a decision nobody wrote to is offered the scheduler's three stops only");
  const full = plannerInstructions({ researcherMessages: [{ note: "x" }], materials: [{ name: "a" }], earlierStop: { kind: "needs_input" }, pauseAllowed: true });
  for (const present of ["researcherMessages is", "materials are", "earlierStop is", "pauseAllowed is true", "paused_by_researcher"]) assert.ok(full.includes(present), present);
  assert.equal(plannerInstructions({ researcherMessages: [] }).includes("researcherMessages is"), false, "an empty field is no field");
  // Only the lines whose data is there: a correction alone does not bring the pause.
  const some = plannerInstructions({ researcherMessages: [{ note: "x" }] });
  assert.ok(some.includes("researcherMessages is")); assert.equal(some.includes("paused_by_researcher"), false);
});

test("a pause the researcher asked for is returned as a stop only for their own message", async () => {
  const pause = { action: "stop", stopKind: RESEARCHER_PAUSE_KIND, reason: "你说先暂停，等你补充后再继续" };
  const { instance } = planner(async () => answer(pause));
  assert.deepEqual(await instance.decide(input({ stopAllowed: false, pauseAllowed: true })), { ...pause, model: "deepseek-flash" });
  await assert.rejects(() => instance.decide(input({ stopAllowed: true })), { code: "autopilot_planner_invalid" });
});

test("a planner that is switched off or has no provider says so and calls nothing", async () => {
  for (const extra of [{ autopilotPlannerEnabled: false }, { deepseekProviderEnabled: false }, { deepseekApiKey: "" }]) {
    const { instance, calls } = planner(async () => answer(run), extra);
    assert.equal(instance.available, false);
    await assert.rejects(() => instance.decide(input()), { code: "autopilot_planner_unavailable" });
    assert.equal(calls.length, 0);
  }
  assert.equal(new AutopilotPlanner(config()).available, true, "on by default once a provider is configured");
});

test("a spent budget is the gateway's own refusal, passed on by name and never a reason to rest the planner", async () => {
  const { instance, calls } = planner(async () => { throw Object.assign(new Error("over"), { code: "usage_budget_exceeded", status: 402 }); });
  for (let attempt = 0; attempt < 5; attempt += 1) await assert.rejects(() => instance.decide(input()), { code: "usage_budget_exceeded" });
  assert.equal(calls.length, 5, "a budget is per account: it must not stop the next agenda's decision");
  assert.equal(instance.counters.budgetSpent, 5);
  assert.equal(instance.lastFailure, "usage_budget_exceeded");
});

test("an answer that cannot be used is counted and dropped, a cut-off one too", async () => {
  const answers = [answer("I think you should run evidence-update"), answer({ ...run, taskType: "literature-sentinel" }),
    { choices: [{ finish_reason: "length", message: { content: JSON.stringify(run) } }] }];
  const { instance } = planner(async (_call, n) => answers[n - 1]);
  await assert.rejects(() => instance.decide(input()), { code: "autopilot_planner_invalid" });
  await assert.rejects(() => instance.decide(input()), { code: "autopilot_planner_invalid" });
  await assert.rejects(() => instance.decide(input()), { code: "autopilot_planner_incomplete" });
  assert.equal(instance.counters.invalid, 2);
});

test("a call that outlives its deadline is abandoned", async () => {
  const { instance } = planner((call) => new Promise((_resolve, reject) => {
    call.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  }), { autopilotPlannerTimeoutMs: 1_000 });
  const started = Date.now();
  await assert.rejects(() => instance.decide(input()), { code: "autopilot_planner_timeout" });
  assert.ok(Date.now() - started < 5_000);
});

test("three provider failures in a row rest the planner for a few minutes, so a scheduler loop is not held by a dead provider", async () => {
  let clock = 1_000_000;
  let healthy = false;
  const { instance, calls } = planner(async () => { if (!healthy) throw Object.assign(new Error("down"), { code: "model_gateway_upstream_error" }); return answer(run); },
    {}, { now: () => clock });
  for (let attempt = 0; attempt < 3; attempt += 1) await assert.rejects(() => instance.decide(input()), { code: "model_gateway_upstream_error" });
  await assert.rejects(() => instance.decide(input()), { code: "autopilot_planner_circuit_open" });
  await assert.rejects(() => instance.decide(input()), { code: "autopilot_planner_circuit_open" });
  assert.equal(calls.length, 3, "the resting planner made no call");
  assert.equal(instance.counters.circuitOpen, 2);
  clock += 5 * 60_000 + 1;
  healthy = true;
  assert.equal((await instance.decide(input())).taskType, "evidence-update");
  assert.equal(calls.length, 4);
});

test("a success between failures starts the count again", async () => {
  let n = 0;
  const { instance } = planner(async () => { n += 1; if (n % 3 !== 0) throw Object.assign(new Error("down"), { code: "model_gateway_upstream_error" }); return answer(run); });
  for (let round = 0; round < 3; round += 1) {
    await assert.rejects(() => instance.decide(input()), { code: "model_gateway_upstream_error" });
    await assert.rejects(() => instance.decide(input()), { code: "model_gateway_upstream_error" });
    await instance.decide(input());
  }
  assert.equal(instance.counters.circuitOpen, 0);
});

test("the operator sees how each decision ended, per process", async () => {
  const { autopilotPlannerMetricFamily } = await import("../src/autopilotNextAction.mjs");
  assert.deepEqual(autopilotPlannerMetricFamily(null).series, [], "no planner, no series");
  const { instance } = planner(async (_call, n) => n === 1 ? answer(run) : answer("not json"));
  await instance.decide(input());
  await assert.rejects(() => instance.decide(input()), { code: "autopilot_planner_invalid" });
  const family = autopilotPlannerMetricFamily(instance);
  assert.equal(family.name, "open_science_autopilot_planner_decisions_total");
  assert.equal(family.type, "counter");
  assert.deepEqual(Object.fromEntries(family.series.map((item) => [item.labels.result, item.value])),
    { run: 1, stop: 0, invalid: 1, failed: 0, circuit_open: 0, budget_spent: 0 });
});
