// What a run is called (C3, 2026-09-18).
//
// Runs were listed by their question, and a run started from a capability card
// stored the card's naming line as the first thing its question said, so a
// ledger of twelve runs of one capability read as twelve copies of one
// sentence. A run now has a title: what it asked until one small model call
// names it, and the researcher's own name once they give one — which nothing
// automatic may replace.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { capabilityBrief } from "@evimed/domain";
import { AgentRunStore, normalizeRunTitle } from "../src/agentRuns.mjs";
import { createWebApiApp } from "../src/server.mjs";
import { RunTitleScheduler, RunTitler, cleanRunTitle } from "../src/runTitles.mjs";

const flashConfig = { runTitlesEnabled: true, deepseekProviderEnabled: true, deepseekApiKey: "test-only-key", deepseekModel: "deepseek-flash" };

async function withStore(fn, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "os-run-titles-"));
  const project = { id: "p1", userId: "u1", rootDir: root, workspaceDir: root, metaDir: path.join(root, ".openscience") };
  await mkdir(project.metaDir, { recursive: true });
  const binding = { sessionId: options.sessionId ?? "ses_title", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
  const states = [];
  const store = new AgentRunStore({ get: async () => (options.unbound ? null : binding) }, {
    model: "deepseek/deepseek-flash", monitorIntervalMs: 60_000, monitorMaxPolls: 1,
    readSessionHistory: options.readSessionHistory ?? (async () => []), readSessionStatus: async () => "idle",
    onRunStateChanged: (_project, run) => states.push(run),
  });
  store.scheduleMonitor = () => {};
  try {
    await fn({ store, project, binding, states });
  } finally {
    await store.closeAll();
    await rm(root, { recursive: true, force: true });
  }
}

test("a model's title is cleaned to one short line, and anything else is no title", () => {
  assert.equal(cleanRunTitle("「阿司匹林一级预防在≥70岁人群的获益」。"), "阿司匹林一级预防在≥70岁人群的获益");
  assert.equal(cleanRunTitle("  Metformin and lactic\\nacidosis risk  ".replace("\\n", "\n")), "Metformin and lactic acidosis risk");
  assert.equal(cleanRunTitle("一".repeat(24)), "一".repeat(24));
  assert.equal(cleanRunTitle("一".repeat(25)), null, "longer than a list can show is not a title");
  assert.equal(cleanRunTitle(""), null);
  assert.equal(cleanRunTitle("。"), null);
  assert.equal(cleanRunTitle(42), null);
  assert.equal(normalizeRunTitle("两行\n标题"), "两行 标题");
  assert.equal(normalizeRunTitle("x".repeat(81)), null);
});

test("the titler makes one metered flash call attributed to the run, and fails safe", async () => {
  const calls = [];
  const answer = (message) => ({ choices: [{ message }] });
  let reply = answer({ content: "{\"title\": \"二甲双胍与乳酸酸中毒风险\"}" });
  const titler = new RunTitler(flashConfig, {
    usageLedger: { marker: true },
    callModel: async (deps, call) => { calls.push({ deps, call }); if (reply instanceof Error) throw reply; return reply; },
  });
  const owner = { userId: "u1", projectId: "p1", runId: "run_1" };
  assert.equal(await titler.titleFor("二甲双胍会不会增加乳酸酸中毒风险？", owner), "二甲双胍与乳酸酸中毒风险");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].call.runId, "run_1", "the call is charged to the run it names");
  assert.equal(calls[0].call.userId, "u1");
  assert.equal(calls[0].call.purpose, "title", "the ledger can say what titles cost");
  assert.equal(calls[0].call.body.model, "deepseek-flash");
  // A title needs no reasoning: thinking off costs a thirtieth of the tokens.
  assert.deepEqual(calls[0].call.body.thinking, { type: "disabled" });
  assert.deepEqual(calls[0].deps.usageLedger, { marker: true }, "through the metered control-plane path");
  // The answer written into the reasoning text still counts.
  reply = answer({ content: "", reasoning_content: "思考……最后答案 {\"title\": \"阿司匹林一级预防\"}" });
  assert.equal(await titler.titleFor("问题", owner), "阿司匹林一级预防");
  for (const failure of [answer({ content: "not json" }), answer({ content: "{\"title\": \"" + "长".repeat(40) + "\"}" }), Object.assign(new Error("down"), { code: "model_gateway_upstream_error" })]) {
    reply = failure;
    assert.equal(await titler.titleFor("问题", owner), null, "a failure is no title, never a throw");
  }
  const before = calls.length;
  assert.equal(await new RunTitler({ ...flashConfig, runTitlesEnabled: false }, { callModel: async () => assert.fail("called while off") }).titleFor("问题", owner), null);
  assert.equal(await new RunTitler({ ...flashConfig, deepseekApiKey: "" }, { callModel: async () => assert.fail("called with no key") }).titleFor("问题", owner), null);
  assert.equal(calls.length, before);
});

test("a run is titled once, only while it is still named by its question, and never when it is old", async () => {
  const recorded = [];
  const asked = [];
  const scheduler = new RunTitleScheduler({
    titler: { available: true, titleFor: async (question) => { asked.push(question); return `标题：${question.slice(0, 4)}`; } },
    recordTitle: async (_project, runId, title) => { recorded.push({ runId, title }); },
    now: () => Date.parse("2026-09-18T12:00:00.000Z"),
  });
  const project = { id: "p1", userId: "u1" };
  const fresh = { id: "run_a", question: "阿司匹林一级预防", titleSource: "question", createdAt: "2026-09-18T11:59:00.000Z" };
  scheduler.consider(project, fresh);
  scheduler.consider(project, fresh);
  scheduler.consider(project, { ...fresh, id: "run_user", titleSource: "user" });
  scheduler.consider(project, { ...fresh, id: "run_auto", titleSource: "auto" });
  scheduler.consider(project, { ...fresh, id: "run_blank", question: null });
  scheduler.consider(project, { ...fresh, id: "run_old", createdAt: "2026-09-01T00:00:00.000Z" });
  await scheduler.settle();
  assert.deepEqual(asked, ["阿司匹林一级预防"]);
  assert.deepEqual(recorded, [{ runId: "run_a", title: "标题：阿司匹林" }]);
  const quiet = new RunTitleScheduler({ titler: { available: false, titleFor: async () => assert.fail("off") }, recordTitle: async () => assert.fail("off") });
  quiet.consider(project, { ...fresh, id: "run_off" });
  await quiet.settle();
});

test("a card's naming line never reaches the question, and every run has a title", async () => {
  await withStore(async ({ store, project, binding }) => {
    const run = await store.dispatch(project, {
      sessionId: binding.sessionId, dispatchId: "card_1",
      question: capabilityBrief("临床证据深度分析", "≥70 岁人群阿司匹林一级预防的获益与出血风险"),
    }, async () => ({ accepted: true }));
    assert.equal(run.question, "≥70 岁人群阿司匹林一级预防的获益与出血风险");
    assert.equal(run.title, "≥70 岁人群阿司匹林一级预防的获益与出血风险");
    assert.equal(run.titleSource, "question");
  });
  // A ledger written before the rule reads the same way.
  await withStore(async ({ store, project }) => {
    const { writeFile } = await import("node:fs/promises");
    const started = (id, question, extra = {}) => JSON.stringify({
      event: "started", id, dispatchId: null, dispatchStatus: "accepted", kernelRequestIds: [], sessionId: `ses_${id}`,
      mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null, effectiveAgentId: null, effectiveAgentVersion: null,
      effectiveRuntimeAgent: null, effectiveRouteReason: null, model: "deepseek/deepseek-flash", question,
      createdAt: "2026-09-01T00:00:00.000Z", startedAt: "2026-09-01T00:00:00.000Z", baselineCursor: null, ...extra,
    });
    await writeFile(path.join(project.metaDir, "runs.jsonl"), [
      started("run_old", "请以「临床证据深度分析」能力完成以下任务： 原来的问题"),
      started("run_long", "长".repeat(60)),
      started("run_routed", null, { effectiveAgentId: "clinical-evidence-synthesis", effectiveAgentVersion: "2.0.0", effectiveRuntimeAgent: "evimed-clinical-evidence-synthesis" }),
      started("run_blank", null),
    ].join("\n") + "\n", "utf8");
    const runs = new Map((await store.list(project)).map((run) => [run.id, run]));
    assert.equal(runs.get("run_old").question, "原来的问题");
    assert.equal(runs.get("run_long").title, `${"长".repeat(39)}…`);
    assert.equal(runs.get("run_routed").title, "临床证据深度分析", "no question: the capability it was routed to");
    assert.equal(runs.get("run_blank").title, "未命名的研究");
    for (const run of runs.values()) assert.equal(run.titleSource, "question");
  });
});

test("a researcher's title is locked against automatic ones, and a question is filled once", async () => {
  await withStore(async ({ store, project, binding, states }) => {
    const run = await store.dispatch(project, { sessionId: binding.sessionId, dispatchId: "lock_1", question: "二甲双胍与乳酸酸中毒" }, async () => ({ accepted: true }));
    const auto = await store.recordRunLabels(project, run.id, { title: "二甲双胍的乳酸酸中毒风险", titleSource: "auto" });
    assert.deepEqual([auto.title, auto.titleSource], ["二甲双胍的乳酸酸中毒风险", "auto"]);
    assert.equal(states.at(-1).title, "二甲双胍的乳酸酸中毒风险", "a rename is published like any state change");
    const mine = await store.recordRunLabels(project, run.id, { title: "我的二甲双胍问题", titleSource: "user" });
    assert.deepEqual([mine.title, mine.titleSource], ["我的二甲双胍问题", "user"]);
    const ignored = await store.recordRunLabels(project, run.id, { title: "自动标题", titleSource: "auto" });
    assert.deepEqual([ignored.title, ignored.titleSource], ["我的二甲双胍问题", "user"], "no automatic title replaces the researcher's");
    const renamed = await store.recordRunLabels(project, run.id, { title: "改过的名字", titleSource: "user" });
    assert.equal(renamed.title, "改过的名字", "the researcher's next rename does");
    const kept = await store.recordRunLabels(project, run.id, { question: "另一个问题" });
    assert.equal(kept.question, "二甲双胍与乳酸酸中毒", "a question is never rewritten");
    // Refused shapes, and a run that does not exist.
    await assert.rejects(store.recordRunLabels(project, run.id, { title: "   ", titleSource: "user" }), { code: "invalid_payload" });
    await assert.rejects(store.recordRunLabels(project, run.id, { title: "x".repeat(81), titleSource: "user" }), { code: "invalid_payload" });
    await assert.rejects(store.recordRunLabels(project, "run_missing", { title: "名字", titleSource: "user" }), { code: "agent_run_not_found" });
    // What survives a fold of the ledger is what was written.
    const listed = (await store.list(project)).find((item) => item.id === run.id);
    assert.deepEqual([listed.title, listed.titleSource, listed.question], ["改过的名字", "user", "二甲双胍与乳酸酸中毒"]);
  });
});

test("a run adopted before its first message could be read learns what it asked, from the person's message only", async () => {
  const history = [
    // Injected context is a user-role message too; the sender is what counts.
    { info: { id: "m0", role: "user", source: "system" }, parts: [{ type: "text", text: "<evimed-memory>过去的偏好</evimed-memory>" }] },
    { info: { id: "m1", role: "user", source: "user" }, parts: [{ type: "text", text: "阿司匹林对 70 岁以上人群一级预防" }, { type: "text", text: "有没有净获益？" }] },
    { info: { id: "m2", role: "assistant" }, parts: [{ type: "text", text: "……" }] },
  ];
  const reads = [];
  await withStore(async ({ store, project }) => {
    const adopted = await store.adoptRuntimeSession(project, "ses_kernel_ui");
    assert.equal(adopted.question, null);
    assert.equal(adopted.title, "未命名的研究");
    store.backfillQuestions(project, [adopted]);
    store.backfillQuestions(project, [adopted]);
    await Promise.allSettled([...store.backgroundLabels]);
    const filled = (await store.list(project)).find((run) => run.id === adopted.id);
    assert.equal(filled.question, "阿司匹林对 70 岁以上人群一级预防 有没有净获益？");
    assert.equal(filled.title, "阿司匹林对 70 岁以上人群一级预防 有没有净获益？");
    assert.equal(reads.length, 1, "a run is looked up once per interval, however often the list is read");
    assert.deepEqual(reads[0], { sessionId: "ses_kernel_ui", wake: false }, "a list read never wakes a stopped runtime");
  }, {
    unbound: true,
    readSessionHistory: async (_project, sessionId, options) => { reads.push({ sessionId, wake: options?.wake }); return history; },
  });
});

test("the rename route takes a title and nothing else, and the list names every run", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-run-title-route-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: true, runTitlesEnabled: false });
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { "X-Open-Science-Project": "default", "Content-Type": "application/json" };
  try {
    assert.equal((await fetch(`${base}/api/research-sessions/ses_route`, { method: "PUT", headers, body: JSON.stringify({ mode: "open-domain" }) })).status, 200);
    const dispatched = await fetch(`${base}/api/agent-runs/dispatch`, {
      method: "POST", headers,
      body: JSON.stringify({ sessionId: "ses_route", dispatchId: "route_1", text: capabilityBrief("药品安全性分析", "奥希替尼的心脏安全性信号") }),
    });
    assert.equal(dispatched.status, 202);
    const runId = (await dispatched.json()).data.id;
    const renamed = await fetch(`${base}/api/agent-runs/${runId}`, { method: "PATCH", headers, body: JSON.stringify({ title: "奥希替尼心脏安全性" }) });
    assert.equal(renamed.status, 200);
    const body = (await renamed.json()).data;
    assert.deepEqual([body.id, body.title, body.titleSource], [runId, "奥希替尼心脏安全性", "user"]);
    for (const [label, payload, status] of [
      ["an unknown field", { title: "x", status: "succeeded" }, 400],
      ["no title", {}, 400],
      ["a non-string title", { title: 7 }, 400],
      ["a blank title", { title: "  " }, 400],
    ]) {
      const response = await fetch(`${base}/api/agent-runs/${runId}`, { method: "PATCH", headers, body: JSON.stringify(payload) });
      assert.equal(response.status, status, label);
    }
    const missing = await fetch(`${base}/api/agent-runs/run_missing`, { method: "PATCH", headers, body: JSON.stringify({ title: "名字" }) });
    assert.equal(missing.status, 404);
    const [listed] = (await (await fetch(`${base}/api/agent-runs`, { headers })).json()).data;
    assert.equal(listed.question, "奥希替尼的心脏安全性信号", "the card's naming line is not part of what was asked");
    assert.equal(listed.title, "奥希替尼心脏安全性");
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
