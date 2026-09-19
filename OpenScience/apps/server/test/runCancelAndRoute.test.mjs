// Stopping a run, and telling the researcher where it went and for how long
// (C3, 2026-09-18; appendix E §5.3 and §9.2).
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { capabilityBrief } from "@evimed/domain";
import { AgentRunStore } from "../src/agentRuns.mjs";
import { runFinishedNotifies } from "../src/notificationService.mjs";
import { RUN_ESTIMATE_FALLBACKS, normalizeRunEstimate, routeReasonText, runEstimate } from "../src/runRoute.mjs";
import { createWebApiApp } from "../src/server.mjs";
import { HttpError } from "../src/security.mjs";

test("every route reason the router mints reads as one Chinese sentence, and an unknown one reads as nothing", () => {
  const cases = [
    ["session-binding", "meta-analysis", /^按这个对话选定的能力「.+」运行$/],
    ["unrouted:open-domain", "open-domain-answer", /^直接回答：这个问题不需要交付报告$/],
    ["unrouted:open-domain:classifier:timeout", "open-domain-answer", /^直接回答：这个问题不需要交付报告（路由判断没有给出结论，按规则处理）$/],
    ["llm:0.87", "clinical-evidence-synthesis", /^按问题内容交给「临床证据深度分析」$/],
    ["matched:named:meta-analysis", "meta-analysis", /^你在问题里点名了「.+」$/],
    ["matched:clinical-evidence-synthesis:safety-medicine", "clinical-evidence-synthesis", /^问题提到了需要核对用药安全的药品，交给「临床证据深度分析」$/],
    ["matched:adr-analysis", "adr-analysis", /^按问题里的交付要求交给「.+」$/],
    ["matched:adr-analysis:classifier:empty_content", "adr-analysis", /^按问题里的交付要求交给「.+」（路由判断没有给出结论，按规则处理）$/],
    ["autopilot:literature-sentinel", "clinical-evidence-synthesis", /^主动科研任务$/],
    ["adopted:runtime-ui", null, /^来自对话窗口$/],
    ["adopted:runtime-ui:llm:0.91", "clinical-evidence-synthesis", /^来自对话窗口，按问题内容交给「临床证据深度分析」$/],
    // The conversation window's assistant decides whether to deliver; the
    // note says where the task came from and claims nothing about reports.
    ["adopted:runtime-ui:unrouted:open-domain", "open-domain-answer", /^来自对话窗口$/],
  ];
  for (const [reason, agent, expected] of cases) {
    const text = routeReasonText(reason, agent);
    assert.match(String(text), expected, `${reason} → ${text}`);
    assert.doesNotMatch(String(text), /[a-z]{4,}/, `${reason} leaked a machine word: ${text}`);
  }
  assert.equal(routeReasonText("choice:answer", "open-domain-answer"), "按你的选择：普通问答");
  assert.equal(routeReasonText("choice:clinical-evidence-synthesis", "clinical-evidence-synthesis"), "按你的选择：临床证据深度分析");
  assert.equal(routeReasonText("choice:no-such-capability", "no-such-capability"), "按你的选择：对应的能力");
  assert.equal(routeReasonText("something-new", "x"), null, "a reason this build does not know is not guessed at");
  assert.equal(routeReasonText(null, null), null);
  assert.equal(routeReasonText("llm:0.87", "no-such-capability"), "按问题内容交给对应的能力");
});

test("an estimate is the capability's display range, else its manifest's, else the fallback table", () => {
  assert.deepEqual(runEstimate({ id: "x", display: { estimatedMinutes: { min: 30, max: 70 } }, estimatedMinutes: [30, 120] }), { min: 30, max: 70 });
  assert.deepEqual(runEstimate({ id: "x", estimatedMinutes: [20, 40] }), { min: 20, max: 40 });
  assert.deepEqual(runEstimate({ id: "open-domain-answer" }), RUN_ESTIMATE_FALLBACKS.answer);
  assert.deepEqual(runEstimate({ id: "one", produces: [{}] }), RUN_ESTIMATE_FALLBACKS.single);
  assert.deepEqual(runEstimate({ id: "several", produces: [{}, {}] }), RUN_ESTIMATE_FALLBACKS.deep);
  assert.equal(runEstimate(null), null);
  for (const bad of [[5, 1], [0, 3], { min: 1 }, "10-20", [1, 999]]) assert.equal(normalizeRunEstimate(bad), null, JSON.stringify(bad));
});

async function withStore(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "os-run-cancel-"));
  const project = { id: "p1", userId: "u1", rootDir: root, workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, ".openscience") };
  await mkdir(project.workspaceDir, { recursive: true });
  await mkdir(project.metaDir, { recursive: true });
  const binding = { sessionId: "ses_cancel", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
  const store = new AgentRunStore({ get: async () => binding }, {
    model: "deepseek/deepseek-flash", monitorIntervalMs: 60_000, monitorMaxPolls: 1,
    readSessionHistory: async () => [], readSessionStatus: async () => "idle",
  });
  store.scheduleMonitor = () => {};
  try {
    await fn({ store, project, binding });
  } finally {
    await store.closeAll();
    await rm(root, { recursive: true, force: true });
  }
}

test("a run keeps the estimate and the route it was dispatched with, in the reader's words", async () => {
  await withStore(async ({ store, project, binding }) => {
    const run = await store.dispatch(project, {
      sessionId: binding.sessionId, dispatchId: "route_1", question: "问题",
      effectiveAgentId: "clinical-evidence-synthesis", effectiveAgentVersion: "2.0.0",
      effectiveRuntimeAgent: "evimed-clinical-evidence-synthesis", effectiveRouteReason: "llm:0.93",
      estimatedMinutes: { min: 30, max: 120 },
    }, async () => ({ accepted: true }));
    assert.deepEqual(run.estimatedMinutes, { min: 30, max: 120 });
    assert.equal(run.routeReason, "按问题内容交给「临床证据深度分析」");
    assert.equal(run.effectiveRouteReason, "llm:0.93", "the machine reason stays for operations");
    const [listed] = await store.list(project);
    assert.deepEqual(listed.estimatedMinutes, { min: 30, max: 120 });
    await assert.rejects(store.dispatch(project, { sessionId: "ses_other", dispatchId: "route_2", estimatedMinutes: { min: 9, max: 3 } }, async () => ({ accepted: true })),
      { code: "invalid_agent_run" });
  });
});

test("cancelling records who stopped the run, is idempotent, and names the children it knew", async () => {
  await withStore(async ({ store, project, binding }) => {
    const run = await store.dispatch(project, { sessionId: binding.sessionId, dispatchId: "stop_1", question: "问题" }, async () => ({ accepted: true }));
    store.noteRunEvent(project, run.id, { sessionId: "ses_child", child: true, event: { type: "turn/start", seq: 1 } });
    assert.deepEqual(store.knownChildSessions(run), ["ses_child"]);
    const canceled = await store.cancelRun(project, run.id, { by: "user" });
    assert.equal(canceled.status, "canceled");
    assert.equal(canceled.canceledBy, "user");
    assert.equal(canceled.errorCode, "runtime_canceled");
    const again = await store.cancelRun(project, run.id, { by: "user" });
    assert.equal(again.status, "canceled", "a second stop returns the run as it is");
    assert.equal((await store.list(project)).length, 1);
    await assert.rejects(store.cancelRun(project, "run_missing"), { code: "agent_run_not_found" });
    // The researcher is not told what they did; they are told what the platform did.
    assert.equal(runFinishedNotifies(canceled), false);
    const next = await store.dispatch(project, { sessionId: binding.sessionId, dispatchId: "stop_2", question: "问题" }, async () => ({ accepted: true }));
    await store.closeProject(project, "canceled");
    const shutDown = (await store.list(project)).find((item) => item.id === next.id);
    assert.equal(shutDown.canceledBy, "platform");
    assert.equal(runFinishedNotifies(shutDown), true);
    assert.equal(runFinishedNotifies({ status: "canceled" }), false, "a stop the kernel reported alone counts as the person's");
    assert.equal(runFinishedNotifies({ status: "failed", dispatchStatus: "rejected" }), false);
    assert.equal(runFinishedNotifies({ status: "succeeded" }), true);
    // A short conversational answer is already on screen; the inbox would
    // repeat it with nothing to open. Longer work, files and safety still say so.
    assert.equal(runFinishedNotifies({ status: "succeeded", durationMs: 3_000, artifacts: [] }), false);
    assert.equal(runFinishedNotifies({ status: "succeeded", durationMs: 600_000, artifacts: [] }), true, "left to work");
    assert.equal(runFinishedNotifies({ status: "succeeded", durationMs: 30_000, artifacts: ["deliverables/a/report.md"] }), true, "a file to open");
    assert.equal(runFinishedNotifies({ status: "failed", durationMs: 3_000, errorCode: "runtime_exited" }), true, "a failure is news");
    assert.equal(runFinishedNotifies({
      status: "succeeded", durationMs: 3_000, verification: "unverified",
      qualityNotices: [{ code: "clinical_safety_caution", severity: "safety", title: "临床安全", text: "SAFETY — x" }],
    }), true, "safety interrupts");
  });
});

test("the cancel route stops the kernel first, then the ledger, and the dispatch answer says where the run went", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-run-cancel-route-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: true, runTitlesEnabled: false });
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { "X-Open-Science-Project": "default", "Content-Type": "application/json" };
  const kernelCancels = [];
  const cancelRuntimeSession = app.runtimeManager.cancelRuntimeSession.bind(app.runtimeManager);
  app.runtimeManager.cancelRuntimeSession = async (project, sessionId) => {
    kernelCancels.push(sessionId);
    return cancelRuntimeSession(project, sessionId);
  };
  try {
    assert.equal((await fetch(`${base}/api/research-sessions/ses_route_cancel`, { method: "PUT", headers, body: JSON.stringify({ mode: "open-domain" }) })).status, 200);
    const dispatched = await fetch(`${base}/api/agent-runs/dispatch`, {
      method: "POST", headers, body: JSON.stringify({ sessionId: "ses_route_cancel", dispatchId: "cancel_route_1", text: capabilityBrief("药品安全性分析", "问一个问题") }),
    });
    assert.equal(dispatched.status, 202);
    const run = (await dispatched.json()).data;
    assert.equal(typeof run.routeReason, "string", "the dispatch answer carries the route in the reader's words");
    assert.ok(run.estimatedMinutes && run.estimatedMinutes.min >= 1 && run.estimatedMinutes.max >= run.estimatedMinutes.min, JSON.stringify(run.estimatedMinutes));
    // A run that is certainly still going, written the way the ledger holds
    // one: the mock runtime ends its own runs before a test can stop them.
    const ledger = path.join(dataDir, "users", "dev", "projects", "default", ".openscience", "runs.jsonl");
    await appendFile(ledger, `${JSON.stringify({
      event: "started", id: "run_going", dispatchId: null, dispatchStatus: "accepted", kernelRequestIds: [], sessionId: "ses_going",
      mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null, effectiveAgentId: null, effectiveAgentVersion: null,
      effectiveRuntimeAgent: null, effectiveRouteReason: null, model: "deepseek/deepseek-flash", question: "还在跑的研究",
      createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), baselineCursor: null,
    })}\n`, "utf8");
    assert.equal((await fetch(`${base}/api/agent-runs/run_going/cancel`, { method: "POST", headers, body: JSON.stringify({ reason: "x" }) })).status, 400);
    assert.equal((await fetch(`${base}/api/agent-runs/run_missing/cancel`, { method: "POST", headers, body: "{}" })).status, 404);
    assert.deepEqual(kernelCancels, [], "a refused request reaches no kernel");
    const stopped = await fetch(`${base}/api/agent-runs/run_going/cancel`, { method: "POST", headers, body: "{}" });
    assert.equal(stopped.status, 200);
    const answer = (await stopped.json()).data;
    assert.equal(answer.run.id, "run_going");
    assert.equal(answer.run.status, "canceled");
    assert.equal(answer.run.canceledBy, "user");
    assert.deepEqual(kernelCancels, ["ses_going"], "the kernel was told about the run's own session");
    assert.ok(["runtime-not-running", "session-not-found"].includes(answer.cancellation.root),
      `nothing was running, so there was nothing left to stop: ${answer.cancellation.root}`);
    assert.deepEqual(answer.cancellation.children, []);
    const repeated = await fetch(`${base}/api/agent-runs/run_going/cancel`, { method: "POST", headers, body: "{}" });
    assert.equal(repeated.status, 200, "a second stop is not an error");
    assert.equal((await repeated.json()).data.cancellation.root, "not-running");
    assert.equal(kernelCancels.length, 1, "and asks the kernel nothing");

    // A kernel that is there and cannot be reached leaves the run running: a
    // ledger that says 「已取消」 while the kernel keeps spending is worse
    // than an error the page can retry.
    await appendFile(ledger, `${JSON.stringify({
      event: "started", id: "run_unreachable", dispatchId: null, dispatchStatus: "accepted", kernelRequestIds: [], sessionId: "ses_unreachable",
      mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null, effectiveAgentId: null, effectiveAgentVersion: null,
      effectiveRuntimeAgent: null, effectiveRouteReason: null, model: "deepseek/deepseek-flash", question: "另一项",
      createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), baselineCursor: null,
    })}\n`, "utf8");
    app.runtimeManager.cancelRuntimeSession = async () => {
      throw new HttpError(504, "runtime_cancel_unavailable", "Runtime session cancellation did not answer in time.");
    };
    const unreachable = await fetch(`${base}/api/agent-runs/run_unreachable/cancel`, { method: "POST", headers, body: "{}" });
    assert.equal(unreachable.status, 504);
    const still = (await (await fetch(`${base}/api/agent-runs`, { headers })).json()).data.find((item) => item.id === "run_unreachable");
    assert.equal(still.status, "running");
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a line the researcher chose replaces the router and is said as theirs", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-run-line-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: true, runTitlesEnabled: false });
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { "X-Open-Science-Project": "default", "Content-Type": "application/json" };
  const put = (sessionId, binding) => fetch(`${base}/api/research-sessions/${sessionId}`, { method: "PUT", headers, body: JSON.stringify(binding) });
  const dispatch = (body) => fetch(`${base}/api/agent-runs/dispatch`, { method: "POST", headers, body: JSON.stringify(body) });
  // Asked of the router, this names a capability and goes to it.
  const text = capabilityBrief("药品安全性分析", "华法林与阿司匹林合用的出血风险");
  try {
    assert.equal((await put("ses_routed", { mode: "open-domain" })).status, 200);
    const routed = (await (await dispatch({ sessionId: "ses_routed", dispatchId: "line_routed", text })).json()).data;
    assert.notEqual(routed.effectiveAgentId, "open-domain-answer", "the control: without a choice this question is routed to a capability");

    // 「改为普通问答」: the same question, pinned to the answer line.
    assert.equal((await put("ses_answer", { mode: "open-domain" })).status, 200);
    const answered = await dispatch({ sessionId: "ses_answer", dispatchId: "line_answer", text, line: "answer" });
    assert.equal(answered.status, 202, await answered.clone().text());
    const answer = (await answered.json()).data;
    assert.equal(answer.effectiveAgentId, "open-domain-answer");
    assert.equal(answer.effectiveRouteReason, "choice:answer", "no router and no classifier had a say");
    assert.equal(answer.routeReason, "按你的选择：普通问答");

    // Any public capability, by id, for a question the router would send elsewhere.
    assert.equal((await put("ses_meta", { mode: "open-domain" })).status, 200);
    const meta = (await (await dispatch({ sessionId: "ses_meta", dispatchId: "line_meta", text: "今天天气怎么样", line: "meta-analysis" })).json()).data;
    assert.equal(meta.effectiveAgentId, "meta-analysis");
    assert.equal(meta.effectiveRouteReason, "choice:meta-analysis");
    assert.match(meta.routeReason, /^按你的选择：/);
    assert.ok(meta.estimatedMinutes, "the chosen capability's estimate comes with it");

    // Refused, not ignored: a line that is not one, a capability this
    // deployment does not offer publicly, and a conversation that already has one.
    assert.equal((await put("ses_bad", { mode: "open-domain" })).status, 200);
    for (const line of ["Answer", "", 7, "no-such-capability", "source-understanding", "open-domain-answer"]) {
      const refused = await dispatch({ sessionId: "ses_bad", dispatchId: `line_bad_${String(line).length}_${typeof line}`, text: "问题", line });
      assert.equal(refused.status, 400, `line ${JSON.stringify(line)}`);
      assert.equal((await refused.json()).code, "invalid_agent_run");
    }
    const agents = (await (await fetch(`${base}/api/agents`, { headers })).json()).data;
    const adr = (agents.agents ?? agents).find((agent) => agent.id === "adr-analysis");
    assert.equal((await put("ses_bound", { mode: "specialist", agentId: "adr-analysis", agentVersion: adr.version })).status, 200);
    const bound = await dispatch({ sessionId: "ses_bound", dispatchId: "line_bound", text: "问题", line: "answer" });
    assert.equal(bound.status, 400);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
