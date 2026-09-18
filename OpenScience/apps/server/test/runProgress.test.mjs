// The run's progress, as the ledger and the stream report it.
//
// The fixture at the centre of this file is F4 (2026-09-18, the owner's aspirin
// run): an adopted run whose first deliverable the plan index already called
// `rejected, attempts 2` while the runs page said 「交付进度 0/3 · 待开始 ×3」,
// and whose child was writing files every minute while the monitor announced
// fifteen minutes without observable progress. One function —
// `scopeNativeProjection` — produced both false statements.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentRunStore, scopeNativeProjectionForTest } from "../src/agentRuns.mjs";
import { childSessionHeads } from "../src/runtimeManager.mjs";
import {
  assembleRunProgress,
  claimSummaryOf,
  foldToolEvent,
  normalizeStoredDeliverables,
  normalizeStoredProgress,
  observedCall,
  observedCallsFromHistory,
  progressChildren,
  runDeliverables,
} from "../src/runProgress.mjs";
import { kernelToolText } from "./helpers/kernelToolText.mjs";

const ITEMS = [
  { id: "clinical-evidence", contractKind: "clinical-evidence-report", capability: "clinical-evidence-synthesis", title: "临床证据综述" },
  { id: "adr-analysis", contractKind: "adr-analysis-report", capability: "adr-analysis", title: "不良反应分析" },
  { id: "summary-brief", contractKind: "research-brief", capability: "clinical-evidence-synthesis", title: "摘要" },
];

/** The projection the child's socket wrote in F4, in the plan index's own shape. */
function f4Projection(overrides = {}) {
  return {
    formatVersion: 1,
    runId: "native_k1",
    sessionId: "ses_f4",
    updatedAt: "2026-09-17T22:41:00.000Z",
    plan: {
      revision: 1,
      items: [
        { ...ITEMS[0], dependsOn: [], status: "rejected", attempts: 2,
          issues: [{ code: "clinical_evidence_issue", message: "claims[3].supportQuote not found", severity: "required", check: "claim-quote-verbatim" }] },
        { ...ITEMS[1], dependsOn: [], status: "planned", attempts: 0, issues: [] },
        { ...ITEMS[2], dependsOn: [], status: "planned", attempts: 0, issues: [] },
      ],
    },
    budget: { steps: 40, tokens: 0, children: 1, limits: {} },
    evidence: { total: 23, byStatus: { queued: 8, ready: 13, stale: 2 } },
    gateRuns: [
      { deliverableId: "clinical-evidence", attempt: 1, ok: false, at: "2026-09-17T22:35:00.000Z" },
      { deliverableId: "clinical-evidence", attempt: 2, ok: false, at: "2026-09-17T22:40:00.000Z" },
    ],
    subagents: [{ deliverableId: "clinical-evidence", capability: "clinical-evidence-synthesis", status: "running", childSessionId: "child-1", skills: [] }],
    injectedSkills: [],
    qualityNotices: [],
    degraded: [],
    ...overrides,
  };
}

/** The proof the parent's own transcript supports in F4: a plan, and a
 *  delegation still in flight (a blocking delegate has not completed). */
function f4Run(status = "running") {
  return {
    id: "run_f4",
    sessionId: "ses_f4",
    status,
    nativeTurn: { startSeq: 10, userSeq: 11 },
    nativeWorkflow: {
      turnStartSeq: 10,
      kernelRunId: "native_k1",
      plan: { revision: 1, written: true, items: ITEMS.map(({ title: _title, ...item }) => item) },
      submissions: [],
      delegates: [],
      completion: null,
    },
  };
}

test("F4: while the run is going, an adopted run's plan follows the plan index, not the parent's finished calls", () => {
  const scoped = scopeNativeProjectionForTest(f4Projection(), f4Run("running"));
  assert.ok(scoped, "the F4 projection belongs to this run");
  const [first, second] = scoped.plan.items;
  assert.equal(first.status, "rejected", "item 1 was rejected, and the reader is told so — not 待开始");
  assert.equal(first.attempts, 2, "the child's two submissions are counted");
  assert.equal(second.status, "planned");
  assert.deepEqual(scoped.subagents.map((child) => child.childSessionId), ["child-1"],
    "the working child is kept, so the monitor can read its heartbeat");
  assert.equal(scoped.gateRuns.length, 2, "the child's gate runs belong to the run");

  // Once the run has ended, the terminal reading stands: every state is
  // rebuilt from what the parent was seen to complete.
  const terminal = scopeNativeProjectionForTest(f4Projection(), f4Run("succeeded"));
  assert.equal(terminal.plan.items[0].status, "planned");
  assert.equal(terminal.plan.items[0].attempts, 0);
  assert.deepEqual(terminal.subagents, []);
});

test("an acceptance the plan index claims without a witness or a receipt reads as submitted", () => {
  const claimed = f4Projection();
  claimed.plan.items[0] = { ...claimed.plan.items[0], status: "accepted", attempts: 3 };
  const scoped = scopeNativeProjectionForTest(claimed, f4Run("running"));
  assert.equal(scoped.plan.items[0].status, "submitted", "a model-writable document cannot award itself an acceptance");
  assert.equal(scoped.plan.items[0].attempts, 3);
});

test("the record's plan: verdicts and attempts while running, and what each item became at the end", () => {
  const projection = f4Projection();
  const live = runDeliverables(projection, null, null);
  assert.deepEqual(live[0], {
    id: "clinical-evidence", title: "临床证据综述", capability: "clinical-evidence-synthesis",
    status: "rejected", attempts: 2, lastVerdict: "issues", mustFixCount: 1, childSessionId: "child-1",
  });
  assert.equal(live[1].status, "planned");
  assert.equal(live[1].lastVerdict, undefined);

  // Delivered with its files but never accepted: shipped, marked unverified.
  const ended = runDeliverables(projection, null, {
    status: "succeeded",
    artifacts: [],
    unverifiedArtifacts: ["deliverables/clinical-evidence/clinical-evidence-report.md"],
  });
  assert.equal(ended[0].status, "delivered");
  assert.equal(ended[0].lastVerdict, "unverified");
  assert.equal(ended[0].attempts, 2, "the attempts survive the end of the run");
  assert.equal(ended[1].status, "planned", "an item never started stays planned, not failed");

  // Accepted through the receipt, on a delivered run.
  const accepted = runDeliverables(projection, { entries: [{ deliverableId: "clinical-evidence", capability: "clinical-evidence-synthesis", attempt: 3 }] },
    { status: "succeeded", artifacts: ["deliverables/clinical-evidence/clinical-evidence-report.md"], unverifiedArtifacts: [] });
  assert.equal(accepted[0].status, "delivered");
  assert.equal(accepted[0].lastVerdict, "pass");
  assert.equal(accepted[0].mustFixCount, undefined, "a passed item owes no fixes");

  // Worked on and nothing shipped: failed.
  const failed = runDeliverables(projection, null, { status: "failed", artifacts: [], unverifiedArtifacts: [] });
  assert.equal(failed[0].status, "failed");

  // Stored and read back through the ledger's normalizer unchanged.
  assert.deepEqual(normalizeStoredDeliverables(JSON.parse(JSON.stringify(ended))), ended);
});

test("activity phases count the parent's and the children's calls together", () => {
  const calls = [
    ...observedCallsFromHistory([{ info: { time: { created: 1 } }, parts: [
      { type: "tool", tool: "evimed_plan", callID: "p1", state: { status: "completed", input: {}, output: kernelToolText({ ok: true, data: {} }), completedAt: 1 } },
      { type: "tool", tool: "evimed_delegate", callID: "d1", state: { status: "pending", input: { deliverableId: "clinical-evidence" } } },
    ] }]),
  ];
  /** @type {Map<string, any>} */
  const child = new Map();
  foldToolEvent(child, { type: "tool/call", seq: 2, callId: "s1", tool: "mcp__evimed__literature_search", input: { query: "aspirin" }, narration: "" }, 10);
  foldToolEvent(child, { type: "tool/result", seq: 3, callId: "s1", tool: "mcp__evimed__literature_search", status: "completed", output: "{\"status\":\"success\",\"data\":{}}", narration: "" }, 11);
  foldToolEvent(child, { type: "tool/call", seq: 4, callId: "f1", tool: "mcp__evimed__open_access_full_text", input: { doi: "10.1/x" }, narration: "" }, 12);
  foldToolEvent(child, { type: "tool/result", seq: 5, callId: "f1", tool: "mcp__evimed__open_access_full_text", status: "completed", output: "{\"status\":\"success\",\"artifacts\":[\".evimed-sources/x/full.md\"]}", narration: "" }, 13);
  foldToolEvent(child, { type: "tool/call", seq: 6, callId: "f2", tool: "mcp__evimed__open_access_full_text", input: { doi: "10.1/y" }, narration: "" }, 14);
  foldToolEvent(child, { type: "tool/result", seq: 7, callId: "f2", tool: "mcp__evimed__open_access_full_text", status: "completed", output: "{\"status\":\"error\",\"error\":{\"code\":\"full_text_not_available\"}}", narration: "" }, 15);
  foldToolEvent(child, { type: "tool/call", seq: 8, callId: "w1", tool: "write", input: { file_path: "deliverables/clinical-evidence/clinical-evidence-report.md", content: "…" }, narration: "" }, 16);
  // A replayed call counts once.
  assert.equal(foldToolEvent(child, { type: "tool/call", seq: 2, callId: "s1", tool: "mcp__evimed__literature_search", input: {}, narration: "" }, 17), false);

  const progress = assembleRunProgress({
    deliverables: runDeliverables(f4Projection(), null, null),
    calls: [...calls, ...child.values()],
    projection: f4Projection(),
    children: progressChildren({ projection: f4Projection(), kernelChildren: [{ sessionId: "child-1", running: true }], lastActivity: new Map([["child-1", 16]]) }),
    startedAt: "2026-09-17T22:26:00.000Z",
    now: "2026-09-17T22:41:00.000Z",
  });
  assert.deepEqual(progress.phaseCounts, { search: 1, screen: 0, fulltext: 2, claims: 0, write: 1, deliver: 0 });
  assert.equal(progress.currentPhase, "write", "the most recent labelled call, wherever it ran");
  assert.deepEqual(progress.sources, { searched: 1, included: 13, fullText: 1 },
    "a fetch that preserved nothing is not a full text; readable evidence rows are what was included");
  assert.deepEqual(progress.children, [{ childSessionId: "child-1", deliverableId: "clinical-evidence", state: "running", lastActivityAt: new Date(16).toISOString() }]);
  assert.equal(progress.deliverables[0].status, "rejected");

  // What the ledger keeps and reads back.
  const { deliverables: _deliverables, ...stored } = progress;
  assert.deepEqual(normalizeStoredProgress(JSON.parse(JSON.stringify(stored))), stored);
});

test("the claim tool's running totals are the claim count when a run used it", () => {
  const call = observedCall({
    callId: "u1",
    tool: "evimed_claim_upsert",
    input: { deliverableId: "clinical-evidence", claim: {} },
    status: "completed",
    output: kernelToolText({ ok: true, data: { claimId: "CLM-001", status: "verified", issues: [], totals: { total: 41, verified: 38 } } }),
  });
  assert.deepEqual(call.claimTotals, { deliverableId: "clinical-evidence", total: 41, verified: 38 });
  const progress = assembleRunProgress({ deliverables: [], calls: [call], children: [], startedAt: null, now: new Date(0).toISOString() });
  assert.deepEqual(progress.claims, { total: 41, verified: 38 });
  assert.equal(progress.phaseCounts.claims, 1);
});

test("a claim summary counts verified, unverified, and neither for a derived estimate", () => {
  assert.deepEqual(claimSummaryOf({ counts: { verified: 68, quote_not_found: 2, source_unavailable: 1, no_quote: 1, derived: 3 } }),
    { total: 75, verified: 68, unverified: 4 });
  assert.equal(claimSummaryOf({ counts: {} }), null);
});

test("the kernel's session list names a run's children without any record naming them first", () => {
  const summaries = [
    { sessionId: "child-now", parentSessionId: "root", origin: "subagent", running: true, updatedAt: 2_000, projections: { asOfSeq: 7 } },
    { sessionId: "child-old-turn", parentSessionId: "root", origin: "subagent", running: false, updatedAt: 500, projections: { asOfSeq: 30 } },
    { sessionId: "fork-of-root", parentSessionId: "root", running: false, updatedAt: 2_500, projections: { asOfSeq: 3 } },
    { sessionId: "someone-elses-child", parentSessionId: "other", origin: "subagent", running: true, updatedAt: 2_000, projections: { asOfSeq: 1 } },
  ];
  assert.deepEqual(childSessionHeads(summaries, "root", []), [], "without discovery only candidates count, as before");
  assert.deepEqual(childSessionHeads(summaries, "root", [], { discoverSince: 1_000 }), [
    { sessionId: "child-now", asOfSeq: 7, running: true, discovered: true },
  ], "a child of this root created during this run; not an earlier turn's child, not a fork, not another root's");
  assert.deepEqual(childSessionHeads(summaries, "root", ["child-old-turn"], { discoverSince: 1_000 }).map((row) => row.sessionId),
    ["child-now", "child-old-turn"], "a named candidate still counts whatever its age");
});

/* ------------------------------------------------ the monitor, on F4's shape */

/** A ledger with one adopted native run, a scriptable parent history, and the F4 projection. */
async function f4Store(t, { readChildSessionActivity, stallPolls = 3, maxPolls = 60 } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "os-run-progress-"));
  let store;
  t.after(async () => {
    await store?.closeAll();
    await rm(root, { recursive: true, force: true });
  });
  const project = { id: "project-1", userId: "user-1", rootDir: root, metaDir: path.join(root, ".openscience"), workspaceDir: root };
  await mkdir(project.metaDir, { recursive: true });
  await mkdir(path.join(root, ".evimed-run"), { recursive: true });
  const started = Date.now();
  const planInput = ITEMS.map(({ title: _title, ...item }) => item);
  // The parent's own turn: the question, the plan, and a delegation that has
  // not returned — a blocking `evimed_delegate` is `running` for the child's life.
  const history = [
    { info: { id: "seq_11", role: "user", source: "user", turnStartSeq: 10, sourceRequestId: null }, parts: [{ type: "text", text: "70 岁以上阿司匹林一级预防的获益与出血风险" }] },
    { info: { id: "seq_12", role: "assistant", turnStartSeq: 10, time: { created: started, completed: started } }, parts: [{
      type: "tool", tool: "evimed_plan", callID: "call-plan",
      state: { status: "completed", input: { action: "write", deliverables: planInput }, completedAt: started + 1,
        output: kernelToolText({ ok: true, data: { revision: 1, runId: "native_k1", deliverables: planInput } }) },
    }] },
    { info: { id: "seq_13", role: "assistant", turnStartSeq: 10, time: { created: started + 2, completed: started + 2 } }, parts: [{
      type: "tool", tool: "evimed_delegate", callID: "call-delegate",
      state: { status: "running", input: { deliverableId: "clinical-evidence" }, output: "" },
    }] },
  ];
  const progressFrames = [];
  store = new AgentRunStore({ get: async () => null }, {
    model: "deepseek/deepseek-flash",
    monitorIntervalMs: 1,
    monitorMaxPolls: maxPolls,
    monitorStallPolls: stallPolls,
    progressPublishIntervalMs: 0,
    readSessionHistory: async (_project, sessionId) => (sessionId === "ses_f4" ? history : []),
    readSessionStatus: async () => "busy",
    readChildSessionActivity: readChildSessionActivity ?? (async () => []),
    runtimeWorkspaceRoot: () => root,
    onRunProjection: (_project, _run, type, data) => { if (type === "run/progress") progressFrames.push(data); },
  });
  await writeFile(path.join(root, ".evimed-run", "state.json"), JSON.stringify(f4Projection()), "utf8");
  const { run } = await store.reserveRun(project, { sessionId: "ses_f4", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null }, {
    baselineCursor: "seq_11",
    nativeTurn: { startSeq: 10, userSeq: 11 },
    kernelRequestIds: [],
    startedAt: new Date(started - 1_000).toISOString(),
    question: "70 岁以上阿司匹林一级预防的获益与出血风险",
    effectiveRouteReason: "adopted:runtime-ui:llm:0.82",
  });
  return { root, project, store, run, progressFrames };
}

test("F4 on the monitor: the plan is published as rejected at attempt 2, and a child that keeps working is not a stall", async (t) => {
  let head = 100;
  const asked = [];
  const { project, store, run, progressFrames } = await f4Store(t, {
    stallPolls: 3,
    maxPolls: 40,
    // The kernel's session list: the child's head moves every poll, as a
    // child writing files does.
    readChildSessionActivity: async (_project, parentSessionId, candidates, options) => {
      asked.push({ parentSessionId, candidates: [...candidates], discovering: Number.isFinite(options?.discoverSince) });
      head += 1;
      return [{ sessionId: "child-1", asOfSeq: head, running: true }];
    },
  });
  store.scheduleMonitor(project, run.id);
  await store.monitors.get(run.id)?.promise;

  const [finished] = await store.list(project);
  assert.equal(finished.errorCode, "runtime_monitor_timeout", "the run ran out its window; nothing ended it on a guess");
  assert.equal(finished.qualityNotices.some((notice) => /没有可观测的进展/.test(String(notice?.text ?? notice))), false,
    "a child whose head keeps moving is progress; the monitor must not announce a stall");
  assert.ok(asked.some((call) => call.parentSessionId === "ses_f4" && call.candidates.includes("child-1")),
    "the child the plan index names is asked about under the run's own root session");

  // While it ran, the aggregate said what the plan index said.
  const published = progressFrames.find((frame) => frame.deliverables[0]?.status === "rejected");
  assert.ok(published, `run/progress was published with the item rejected: ${JSON.stringify(progressFrames.map((frame) => frame.deliverables[0]?.status))}`);
  assert.equal(published.deliverables[0].attempts, 2);
  assert.equal(published.children[0].childSessionId, "child-1");
  assert.equal(published.children[0].state, "running");
  // And the last frame, sent ahead of the terminal state, is the ended plan.
  assert.equal(progressFrames.at(-1).deliverables[0].status, "failed");

  // The record keeps the plan after the end — which item was rejected, and how often.
  assert.equal(finished.deliverables[0].id, "clinical-evidence");
  assert.equal(finished.deliverables[0].attempts, 2);
  assert.equal(finished.deliverables[0].status, "failed", "worked on, shipped nothing, run ended");
  assert.ok(finished.progress, "the last progress picture is on the record");
  assert.equal(finished.progress.deliverables[0].id, "clinical-evidence");
});

test("a child nothing named is found through the kernel, and its work keeps the run alive", async (t) => {
  let head = 5;
  const { project, store, run } = await f4Store(t, {
    stallPolls: 3,
    maxPolls: 40,
    readChildSessionActivity: async (_project, _parent, candidates, options) => {
      head += 1;
      // Only a discovery read can name it: no projection row, no stream event.
      return Number.isFinite(options?.discoverSince) || candidates.includes("child-unnamed")
        ? [{ sessionId: "child-unnamed", asOfSeq: head, running: true, discovered: true }]
        : [];
    },
  });
  await writeFile(path.join(project.workspaceDir, ".evimed-run", "state.json"), JSON.stringify(f4Projection({ subagents: [] })), "utf8");
  store.childDiscoveryIntervalMs = 0;
  store.scheduleMonitor(project, run.id);
  await store.monitors.get(run.id)?.promise;
  const [finished] = await store.list(project);
  assert.equal(finished.qualityNotices.some((notice) => /没有可观测的进展/.test(String(notice?.text ?? notice))), false);
});

test("the stall notice names only what the monitor measured", async (t) => {
  const { project, store, run } = await f4Store(t, { stallPolls: 3, maxPolls: 12 });
  store.scheduleMonitor(project, run.id);
  await store.monitors.get(run.id)?.promise;
  const [finished] = await store.list(project);
  const stall = finished.qualityNotices.map((notice) => String(notice?.text ?? notice)).find((line) => /没有可观测的进展/.test(line));
  assert.ok(stall, "a run with no observable movement is still told so");
  assert.doesNotMatch(stall, /工作区/, "nothing checks the workspace, so the notice must not claim it did");
  const ledger = await readFile(path.join(project.metaDir, "runs.jsonl"), "utf8");
  assert.doesNotMatch(ledger, /工作区也没有变化/);
});
