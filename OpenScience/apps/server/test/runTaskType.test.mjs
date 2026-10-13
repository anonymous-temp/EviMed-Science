// What kind of work a finished conversation was (2026-10-13), for the memory map's radar.
//
// One small model call picks one of a closed list; code keeps the answer only if it is on the list, records it once on the run
// ledger, and the radar counts a conversation under the capability that answered when a named one did. Nothing here waits for the
// model, and a failure leaves the conversation unjudged.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentRunStore } from "../src/agentRuns.mjs";
import { TaskTyper, TaskTypeScheduler, taskTypeFrom } from "../src/runTaskType.mjs";
import { TASK_TYPES, TASK_TYPE_IDS, taskTypeLabel } from "../src/taskTypes.mjs";
import { WORK_AXES, workDimension, workOf, workTypeOf, createRunsSource } from "../src/memoryMapSources/runs.mjs";

const config = { taskTypeEnabled: true, taskTypeDailyCalls: 60, deepseekProviderEnabled: true, deepseekApiKey: "test-only-key", deepseekModel: "deepseek-flash" };
const answer = (message) => ({ choices: [{ message }] });

test("the list is closed: seven kinds, each with a word for the radar, and nothing else is a kind", () => {
  assert.deepEqual(TASK_TYPES.map((type) => type.id), ["writing", "documents", "data", "code", "web-research", "medical-evidence", "other"]);
  assert.equal(taskTypeLabel("code"), "代码");
  assert.equal(taskTypeLabel("not-a-kind"), "其他");
  for (const raw of ["{\"type\":\"code\"}", "```json\n{\"type\": \"Documents\"}\n```", "思考…… 答案 {\"type\": \"data\"}"]) assert.ok(TASK_TYPE_IDS.has(taskTypeFrom(raw)), raw);
  for (const raw of ["{\"type\":\"gardening\"}", "{\"type\":\"写作\"}", "{\"type\":7}", "code", "", null, {}]) assert.equal(taskTypeFrom(raw), null, `${JSON.stringify(raw)} is no kind`);
});

test("the judge makes one metered flash call charged to the conversation, shows it the request and the hints, and fails safe", async () => {
  const calls = [];
  let reply = answer({ content: "{\"type\": \"documents\"}" });
  const typer = new TaskTyper(config, { usageLedger: { marker: true }, callModel: async (deps, call) => { calls.push({ deps, call }); if (reply instanceof Error) throw reply; return reply; } });
  const owner = { userId: "u1", projectId: "p1", runId: "run_1" };
  assert.equal(await typer.typeOf({ question: "把这份报告做成十页的幻灯片", capability: null, files: ["out/slides.PPTX", "out/notes.md", "README", "a/b/c.tar.gz"] }, owner), "documents");
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].call.userId, calls[0].call.projectId, calls[0].call.runId, calls[0].call.purpose], ["u1", "p1", "run_1", "task-type"]);
  assert.equal(calls[0].call.body.model, "deepseek-flash");
  assert.deepEqual(calls[0].call.body.thinking, { type: "disabled" }, "a choice among seven words needs no reasoning");
  assert.deepEqual(calls[0].deps.usageLedger, { marker: true }, "through the metered control-plane path");
  const shown = JSON.parse(calls[0].call.body.messages[1].content);
  assert.deepEqual(shown, { request: "把这份报告做成十页的幻灯片", capability: null, files: ["pptx", "md", "gz"] });
  // The instruction names every kind by its id and carries no medical vocabulary of its own beyond the one kind that is medical.
  const system = calls[0].call.body.messages[0].content;
  for (const id of TASK_TYPE_IDS) assert.ok(system.includes(`- ${id}:`), id);
  for (const failure of [answer({ content: "not json" }), answer({ content: "{\"type\": \"gardening\"}" }), Object.assign(new Error("down"), { code: "model_gateway_upstream_error" })]) {
    reply = failure;
    assert.equal(await typer.typeOf({ question: "问题" }, owner), null, "a failure is no judgement, never a throw");
  }
  const before = calls.length;
  assert.equal(await new TaskTyper({ ...config, taskTypeEnabled: false }, { callModel: async () => assert.fail("called while off") }).typeOf({ question: "q" }, owner), null);
  assert.equal(await new TaskTyper({ ...config, taskTypeDailyCalls: 0 }, { callModel: async () => assert.fail("called with a spent day") }).typeOf({ question: "q" }, owner), null);
  assert.equal(await new TaskTyper({ ...config, deepseekApiKey: "" }, { callModel: async () => assert.fail("called with no key") }).typeOf({ question: "q" }, owner), null);
  assert.equal(calls.length, before);
});

const NOW = Date.parse("2026-10-13T08:00:00.000Z");
const finished = (id, extra = {}) => ({ id, status: "succeeded", question: "把这份报告做成幻灯片", finishedAt: "2026-10-13T07:00:00.000Z", effectiveAgentId: "open-domain-answer", ...extra });

function scheduler({ available = true, dailyCalls = 60, answerOf = () => "documents", usageLedger = null, hold = null } = {}) {
  const asked = [];
  const recorded = [];
  const instance = new TaskTypeScheduler({
    typer: { available, typeOf: async (work, owner) => { asked.push({ work, owner }); await hold; return answerOf(work); } },
    recordType: async (_project, runId, type) => { recorded.push({ runId, type }); },
    dailyCalls: () => dailyCalls, usageLedger, now: () => NOW,
  });
  return { instance, asked, recorded };
}
const project = { id: "p1", userId: "u1" };

test("a conversation is judged once, only when it is a researcher's own, finished, asked, not yet judged and recent", async () => {
  const { instance, asked, recorded } = scheduler();
  assert.equal(instance.consider(project, finished("run_a")), true);
  assert.equal(instance.consider(project, finished("run_a")), false, "once");
  for (const [id, change] of [
    ["run_running", { status: "running" }], ["run_failed", { status: "failed" }], ["run_blank", { question: null }], ["run_done", { taskType: "code" }],
    ["run_deleted", { deleted: true }], ["run_auto", { automated: true }], ["run_old", { finishedAt: "2026-07-01T00:00:00.000Z" }],
    // A named capability's category already says what its work is.
    ["run_clinical", { effectiveAgentId: "clinical-evidence-synthesis" }],
  ]) assert.equal(instance.consider(project, finished(id, change)), false, id);
  await instance.settle();
  assert.deepEqual(asked.map((item) => item.owner.runId), ["run_a"]);
  assert.deepEqual(asked[0].work, { question: "把这份报告做成幻灯片", capability: null, files: undefined });
  assert.deepEqual(recorded, [{ runId: "run_a", type: "documents" }]);
  // A conversation answered by an agent the catalogue has no category for is judged, and the judge is told which agent it was.
  const named = scheduler();
  named.instance.consider(project, finished("run_n", { effectiveAgentId: "custom-agent" }));
  await named.instance.settle();
  assert.equal(named.asked[0].work.capability, "custom-agent");
});

test("an answer that is no kind records nothing, an off judge asks nothing, and the account's day is a bound", async () => {
  const bad = scheduler({ answerOf: () => null });
  bad.instance.consider(project, finished("run_b"));
  await bad.instance.settle();
  assert.deepEqual(bad.recorded, []);
  const off = scheduler({ available: false });
  assert.equal(off.instance.consider(project, finished("run_c")), false);
  const bounded = scheduler({ dailyCalls: 2 });
  for (const id of ["r1", "r2", "r3", "r4"]) { bounded.instance.consider(project, finished(id)); await bounded.instance.settle(); }
  assert.deepEqual(bounded.asked.map((item) => item.owner.runId), ["r1", "r2"], "two calls a day, then the day is spent");
  // Another account has a day of its own.
  bounded.instance.consider({ id: "p9", userId: "u2" }, finished("r5"));
  await bounded.instance.settle();
  assert.equal(bounded.asked.at(-1).owner.runId, "r5");
});

test("a day already spent in the usage ledger stays spent after a restart, and three judgements at most are in flight", async () => {
  const seen = [];
  const usageLedger = { summary: async (userId, options) => { seen.push({ userId, ...options }); return { totalCalls: 59 }; } };
  const restarted = scheduler({ dailyCalls: 60, usageLedger });
  for (const id of ["a", "b", "c"]) { restarted.instance.consider(project, finished(id)); await restarted.instance.settle(); }
  assert.equal(restarted.asked.length, 1, "59 of 60 were made before the restart: one more");
  assert.equal(seen.length, 1, "the ledger is asked once for the account's day");
  assert.deepEqual(seen[0].purposes, ["task-type"]);
  assert.equal(seen[0].since.toISOString(), "2026-10-13T00:00:00.000Z");
  let release;
  const held = scheduler({ hold: new Promise((resolve) => { release = resolve; }) });
  const started = ["a", "b", "c", "d", "e"].map((id) => held.instance.consider(project, finished(id)));
  assert.deepEqual(started, [true, true, true, false, false]);
  release();
  await held.instance.settle();
  // The two that found no place were not marked tried: a later read gets them.
  assert.equal(held.instance.consider(project, finished("d")), true);
  await held.instance.settle();
});

test("the ledger records the kind once, as a notice, and a closed list guards both the write and the read", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-task-type-"));
  const proj = { id: "p1", userId: "u1", rootDir: root, workspaceDir: root, metaDir: path.join(root, ".openscience") };
  await mkdir(proj.metaDir, { recursive: true });
  const states = [];
  const store = new AgentRunStore({ get: async () => ({ sessionId: "ses_t", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null }) }, {
    model: "deepseek/deepseek-flash", monitorIntervalMs: 60_000, monitorMaxPolls: 1,
    readSessionHistory: async () => [], readSessionStatus: async () => "idle", onRunStateChanged: (_project, run) => states.push(run),
  });
  store.scheduleMonitor = () => {};
  try {
    const run = await store.dispatch(proj, { sessionId: "ses_t", dispatchId: "tt_1", question: "写一个清洗 CSV 的脚本" }, async () => ({ accepted: true }));
    assert.equal(run.taskType, undefined);
    const { appendFile, readFile } = await import("node:fs/promises");
    const ledger = path.join(proj.metaDir, "runs.jsonl");
    // A ledger line that names a kind off the list is read as no kind.
    await appendFile(ledger, `${JSON.stringify({ event: "notice", id: run.id, at: "2026-10-13T08:00:00.000Z", qualityNotices: [], taskType: "gardening" })}\n`);
    assert.equal((await store.list(proj)).find((item) => item.id === run.id).taskType, undefined);
    await assert.rejects(store.recordRunLabels(proj, run.id, { taskType: "gardening" }), { code: "invalid_payload" });
    const typed = await store.recordRunLabels(proj, run.id, { taskType: "code" });
    assert.equal(typed.taskType, "code");
    assert.equal(states.at(-1).taskType, "code", "published like any state change");
    // Judged once: another answer is the first one's again, and writes nothing.
    const lines = async () => (await readFile(ledger, "utf8")).trim().split("\n").length;
    const before = await lines();
    assert.equal((await store.recordRunLabels(proj, run.id, { taskType: "writing" })).taskType, "code");
    assert.equal(await lines(), before);
    assert.equal((await store.list(proj)).find((item) => item.id === run.id).taskType, "code", "what a fold of the ledger returns");
  } finally {
    await store.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("the radar counts a conversation under its capability's category, else the kind a model judged, and draws the medical axis only when used", () => {
  const run = (id, extra) => ({ id, status: "succeeded", finishedAt: "2026-10-10T00:00:00.000Z", effectiveAgentId: "open-domain-answer", ...extra });
  assert.equal(workTypeOf(run("a", { taskType: "code" })), "code");
  assert.equal(workTypeOf(run("b", {})), null, "not judged yet: counted under nothing");
  assert.equal(workTypeOf(run("c", { effectiveAgentId: "clinical-evidence-synthesis", taskType: "documents" })), "medical-evidence", "the catalogue is the stronger basis");
  assert.equal(workTypeOf(run("d", { effectiveAgentId: "meta-analysis" })), "medical-evidence");
  const work = workOf([run("a", { taskType: "code" }), run("b", {}), run("e", { taskType: "writing" }), run("f", { taskType: "writing" }), run("g", { taskType: "gardening" }), run("h", { taskType: "code", status: "failed" }), run("i", { taskType: "code", deleted: true })]);
  assert.deepEqual(work.map((item) => item.label), ["代码", "写作", "写作"]);
  const radar = workDimension(work, new Date("2026-10-13T00:00:00.000Z"));
  assert.deepEqual(radar.axes.map((axis) => axis.label), ["写作", "文档与演示", "表格与数据分析", "代码", "查资料与调研", "其他"], "no medical axis for an account that has none");
  assert.deepEqual([radar.total, radar.axes.find((axis) => axis.label === "写作").count], [3, 2]);
  assert.ok(Math.abs(radar.axes.find((axis) => axis.label === "写作").value - 2 / 3) < 1e-9);
  const medical = workDimension(workOf([run("d", { effectiveAgentId: "meta-analysis" })]), new Date("2026-10-13T00:00:00.000Z"));
  assert.ok(medical.axes.some((axis) => axis.label === "医学证据"));
  assert.equal(WORK_AXES.filter((axis) => axis.general).length, 6);
});

test("reading the map asks for the newest unjudged conversations to be judged and does not wait for the answer", async () => {
  const asked = [];
  const runs = Array.from({ length: 30 }, (_, index) => ({
    id: `run_${String(index).padStart(2, "0")}`, projectId: "p1", status: "succeeded", question: "q", effectiveAgentId: "open-domain-answer",
    finishedAt: `2026-10-${String(1 + (index % 12)).padStart(2, "0")}T00:00:00.000Z`,
  }));
  const taskTypes = { wants: (run) => run.id !== "run_00", consider: (_project, run) => { asked.push(run.id); return true; } };
  const source = createRunsSource({ agentRuns: { researcherRuns: async () => runs }, projectOf: async (_user, id) => ({ id, userId: "u1" }), taskTypes });
  const read = await source.read({ user: { id: "u1" }, projects: [{ id: "p1" }], projectId: null, now: new Date("2026-10-13T00:00:00.000Z"), memo: (_key, load) => load() });
  assert.equal(asked.length, 12, "a few per read");
  assert.ok(!asked.includes("run_00"));
  assert.equal(read.facets.dimensions[0].id, "work");
  // A judge that throws costs the read nothing.
  const broken = createRunsSource({ agentRuns: { researcherRuns: async () => runs }, projectOf: async (_user, id) => ({ id, userId: "u1" }), taskTypes: { wants: () => true, consider: () => { throw new Error("boom"); } } });
  assert.equal((await broken.read({ user: { id: "u1" }, projects: [{ id: "p1" }], projectId: null, now: new Date("2026-10-13T00:00:00.000Z"), memo: (_key, load) => load() })).facets.dimensions[0].id, "work");
});
