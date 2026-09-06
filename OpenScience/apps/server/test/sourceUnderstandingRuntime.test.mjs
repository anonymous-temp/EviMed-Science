import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSourceUnderstandingRuntime, sourceUnderstandingBudget, sourceRunProject } from "../src/sourceUnderstandingRuntime.mjs";
import { AgentRunStore } from "../src/agentRuns.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "source-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = { id: "project-one", userId: "user-one", rootDir: root, baseDir: root,
    workspaceDir: root, metaDir: path.join(root, ".openscience"), activeWorkspace: "initial" };
  const job = { id: "job-one", userId: project.userId, projectId: project.id, leaseToken: "lease-one",
    payload: { sourceId: `src_${"a".repeat(32)}`, sourceGeneration: 1, accountCreatedAt: "account-one" } };
  const source = { id: job.payload.sourceId, projectId: project.id, payload: { generation: 1, status: "parsing", analysis: {} } };
  const input = { sourceId: source.id, generation: 1, text: "Preserved source text", depth: "structured" };
  const request = { userId: project.userId, projectId: project.id, dispatchId: `source-understanding-${"b".repeat(32)}`,
    job, input, question: "Read source-understanding-input.json and deliver source-understanding.json." };
  const calls = [];
  const state = { current: true, bound: null, scope: null, runs: [], owner: true };
  const config = { sourceUnderstandingRunLimitCny: 3, sourceUnderstandingDailyLimitCny: 10,
    sourceUnderstandingWeeklyLimitCny: 50, userDailySpendLimit: 2, userWeeklySpendLimit: 20,
    deepseekModel: "deepseek-v4-pro", modelGatewaySigningSecret: "fixture-signing-secret-at-least-32-characters" };
  const dependencies = {
    config,
    store: { userById: async () => ({ id: project.userId }), requireProject: async () => project },
    sources: {
      get: async () => source,
      withAttemptCleanup: async (_job, operation) => operation(),
      withIngestionLease: async (_job, operation) => {
        calls.push("lease");
        if (!state.current) throw Object.assign(new Error("stale source lease"), { code: "source_generation_stale" });
        const result = await operation();
        if (!state.current) throw Object.assign(new Error("stale source lease"), { code: "source_generation_stale" });
        return result;
      },
      bindUnderstandingRun: async (_job, binding) => {
        calls.push("bind");
        state.bound = { ...binding, id: binding.runId };
        source.payload.analysis.run = state.bound;
        return source;
      },
      bindUnderstandingLaunch: async (_job, launch) => { calls.push("launch"); source.payload.analysis.launch = launch; },
      understandingLaunchForDispatch: async (_userId, _projectId, dispatchId) => state.owner
        && source.payload.analysis.launch?.dispatchId === dispatchId ? source.payload.analysis.launch : null,
      understandingRunForRun: async (_userId, _projectId, runId) => state.owner && state.bound?.id === runId ? state.bound : null,
    },
    agentRuns: {
      list: async () => state.runs,
      existingDispatch: async (_project, run) => { calls.push("recover"); return run; },
      scheduleMonitor: () => calls.push("monitor"),
      dispatch: async (scoped, args, send) => {
        calls.push("dispatch");
        const run = { id: "run-one", sessionId: args.sessionId, dispatchId: args.dispatchId,
          status: "running", dispatchStatus: "dispatching", artifacts: [], kernelRequestIds: ["request-one"] };
        state.runs.push(run);
        try {
          await send({ sessionId: args.sessionId }, run);
          run.dispatchStatus = "accepted";
        } catch (error) {
          run.status = error.definitivelyRejected ? "failed" : "running";
          run.dispatchStatus = error.definitivelyRejected ? "rejected" : "unknown";
          throw error;
        }
        assert.equal(scoped.workspaceDir, path.join(project.baseDir, state.bound.artifactDirectory));
        return run;
      },
      cancelSession: async (_project, sessionId) => { calls.push(`cancel-ledger:${sessionId}`); },
    },
    runtimeManager: {
      reserveBoundedRuntimeSession: async (_project, scope) => {
        calls.push("reserve"); state.scope = scope;
        return { id: "session-one" };
      },
      dispatchPrompt: async (_project, _session, args) => {
        calls.push("prompt");
        assert.equal(args.allowBounded, true);
        assert.equal(args.model, "deepseek/deepseek-v4-pro");
        assert.ok(!args.text.includes(input.text));
        return { accepted: true };
      },
      boundedRuntimeScope: () => state.scope,
      endBoundedRuntime: async (_project, id) => {
        calls.push(`release:${id}`);
        if (state.scope?.runId === id) state.scope = null;
      },
      cancelRuntimeSession: async (_project, id) => calls.push(`cancel-kernel:${id}`),
    },
    researchSessions: { put: async () => calls.push("session") },
    registry: Promise.resolve({ get: () => ({ id: "source-understanding", version: "1.0.0", runtimeAgent: "evimed-source-understanding", skill: "source-understanding" }) }),
    usageLedger: {
      assertWithinLimits: async () => calls.push("budget"),
      summaryRun: async (_userId, runId) => {
        assert.equal(runId, request.dispatchId);
        return { currency: "CNY", providerId: "deepseek", modelId: "deepseek-v4-pro", actualCost: 0.031,
          inputTokens: 130, outputTokens: 47, settledCalls: 1, reservedCalls: 0, uncertain: 0 };
      },
    },
    prepareContext: async scoped => {
      calls.push("prepare"); assert.equal(scoped.baseDir, scoped.workspaceDir);
      return { system: "managed context" };
    },
    cleanup: async () => calls.push("cleanup"),
  };
  return { project, job, request, input, source, state, dependencies, calls,
    runtime: createSourceUnderstandingRuntime(dependencies) };
}

test("source bounds use finite positive CNY limits and tighter account limits", () => {
  const config = { sourceUnderstandingRunLimitCny: 3, sourceUnderstandingDailyLimitCny: 10,
    sourceUnderstandingWeeklyLimitCny: 50, userDailySpendLimit: 2, userWeeklySpendLimit: 20 };
  assert.deepEqual(sourceUnderstandingBudget(config), { runLimit: 2, dailyLimit: 2, weeklyLimit: 20 });
  for (const value of [0, -1, NaN, Infinity, "3"]) assert.throws(() => sourceUnderstandingBudget({ ...config, sourceUnderstandingRunLimitCny: value }), { code: "source_understanding_budget_invalid" });
});

test("actual dispatch freezes input, binds before preparation, rechecks lease and uses the bounded gateway", async t => {
  const f = await fixture(t);
  const result = await f.runtime.dispatch(f.request);
  assert.equal(result.runId, "run-one");
  assert.equal(f.calls.filter(value => value === "prompt").length, 1);
  assert.ok(f.calls.indexOf("bind") < f.calls.indexOf("prepare"));
  assert.ok(f.calls.slice(f.calls.indexOf("prepare") + 1, f.calls.indexOf("prompt")).includes("lease"));
  const scoped = sourceRunProject(f.project, f.state.bound);
  assert.deepEqual(JSON.parse(await readFile(path.join(scoped.workspaceDir, "source-understanding-input.json"), "utf8")), f.input);
  assert.equal(f.state.scope.runId, f.request.dispatchId);
  assert.equal(f.state.scope.runLimit, 2);
});

test("reclaimed and unknown dispatches never reserve or send a second request", async t => {
  const f = await fixture(t);
  await f.runtime.dispatch(f.request);
  f.state.runs[0].dispatchStatus = "unknown";
  f.project.activeWorkspace = "new-workspace";
  f.job.leaseToken = "replacement-lease";
  f.calls.length = 0;
  assert.equal((await f.runtime.dispatch(f.request)).runId, "run-one");
  assert.equal(f.calls.includes("reserve"), false);
  assert.equal(f.calls.includes("budget"), false);
  assert.equal(f.calls.includes("prompt"), false);
  assert.equal(f.state.bound.workspaceName, "initial");
  f.state.bound = null;
  f.source.payload.analysis.run = null;
  assert.equal((await f.runtime.dispatch(f.request)).runId, "run-one");
  const result = await f.runtime.readResult({ ...f.request, runId: "run-one", sessionId: "session-one" });
  assert.equal(result.status, "pending");
  assert.equal(f.calls.includes("reserve"), false);
  f.state.bound = null;
  f.source.payload.analysis.run = null;
  f.source.payload.analysis.launch = null;
  await assert.rejects(f.runtime.dispatch(f.request), { code: "source_understanding_run_failed" });
});

test("budget rejection and oversized input spend nothing", async t => {
  const f = await fixture(t);
  f.dependencies.usageLedger.assertWithinLimits = async () => { throw Object.assign(new Error("no budget"), { code: "usage_budget_exceeded" }); };
  await assert.rejects(f.runtime.dispatch(f.request), { code: "usage_budget_exceeded" });
  assert.equal(f.calls.includes("reserve"), false);
  await assert.rejects(f.runtime.dispatch({ ...f.request, input: { text: "x".repeat(8 * 1024 * 1024) } }), { code: "source_understanding_input_too_large" });
  assert.equal(f.calls.includes("prompt"), false);
});

test("source supersession during slow context preparation cannot send a model prompt", async t => {
  const f = await fixture(t);
  f.dependencies.prepareContext = async () => { f.state.current = false; return { system: "stale" }; };
  const runtime = createSourceUnderstandingRuntime(f.dependencies);
  const result = await runtime.dispatch(f.request);
  assert.equal(result.runId, "run-one");
  assert.equal(f.state.runs[0].status, "failed");
  assert.equal(f.calls.includes("prompt"), false);
  assert.ok(f.calls.includes(`release:${f.request.dispatchId}`));
});

test("failure cleanup cannot use an old account's path or scope after replacement", async t => {
  const f = await fixture(t);
  f.dependencies.prepareContext = async () => { f.state.current = false; return { system: "stale" }; };
  f.dependencies.sources.withAttemptCleanup = async () => {
    throw Object.assign(new Error("account replaced"), { code: "source_account_changed" });
  };
  await assert.rejects(createSourceUnderstandingRuntime(f.dependencies).dispatch(f.request), { code: "source_account_changed" });
  assert.equal(f.calls.some(value => value.startsWith("release:") || value === "cleanup" || value === "prompt"), false);
});

test("a late source completion or cancellation cannot release a newer scope", async t => {
  const f = await fixture(t);
  await f.runtime.dispatch(f.request);
  f.state.scope = { runId: "new-autopilot-episode" };
  f.calls.length = 0;
  assert.equal(await f.runtime.complete(f.project, f.state.runs[0]), true);
  await f.runtime.cancel({ ...f.request, runId: "run-one", sessionId: "session-one" });
  assert.equal(f.calls.some(value => value.startsWith("release:") || value.startsWith("cancel-kernel:")), false);
  assert.ok(f.calls.includes("cancel-ledger:session-one"));
  f.state.owner = false;
  f.calls.length = 0;
  assert.equal(await f.runtime.complete(f.project, f.state.runs[0]), false);
  assert.equal(await f.runtime.cancel({ ...f.request, runId: "run-one", sessionId: "session-one" }), false);
  assert.deepEqual(f.calls, []);
});

test("a protected launch without a run stops explicitly instead of spending again or waiting forever", async t => {
  const f = await fixture(t);
  await f.runtime.dispatch(f.request);
  f.state.runs = [];
  f.state.bound = null;
  f.source.payload.analysis.run = null;
  f.calls.length = 0;
  await assert.rejects(f.runtime.dispatch(f.request), { code: "source_understanding_run_failed" });
  assert.ok(f.calls.includes(`release:${f.request.dispatchId}`));
  assert.ok(f.calls.includes("cleanup"));
  assert.equal(f.calls.includes("prompt"), false);
  assert.equal(f.calls.includes("reserve"), false);
});

test("launch-only cancellation requires its protected session and cannot stop a newer scope", async t => {
  const f = await fixture(t);
  await f.runtime.dispatch(f.request);
  f.state.bound = null;
  f.source.payload.analysis.run = null;
  f.state.runs = [];
  f.calls.length = 0;
  assert.equal(await f.runtime.cancel({ ...f.request, runId: null, sessionId: "wrong-session" }), false);
  assert.deepEqual(f.calls, []);
  assert.equal(await f.runtime.cancel({ ...f.request, runId: null, sessionId: "session-one" }), true);
  assert.ok(f.calls.includes(`release:${f.request.dispatchId}`));
});

async function acceptedFiles(f) {
  const scoped = sourceRunProject(f.project, f.state.bound);
  const directory = path.join(scoped.workspaceDir, "deliverables", "source-package");
  await mkdir(directory, { recursive: true });
  const output = { summary: "Actual accepted source result" };
  const files = [];
  for (const [name, value] of [["source-understanding-input.json", f.input], ["source-understanding.json", output]]) {
    const content = Buffer.from(JSON.stringify(value));
    const relative = `deliverables/source-package/${name}`;
    await writeFile(path.join(scoped.workspaceDir, relative), content);
    files.push({ path: relative, bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") });
  }
  await writeFile(path.join(scoped.workspaceDir, "delivery-receipt.json"), JSON.stringify({ formatVersion: 1,
    runId: "kernel-run-one", bundleVersion: "1.0.0", domainVersion: "1.0.0", entries: [{
      deliverableId: "source-package", contractKind: "source-understanding", capability: "source-understanding",
      files, acceptedAt: new Date().toISOString(), attempt: 1, notices: [],
    }] }));
  f.state.runs[0].status = "succeeded";
  f.state.runs[0].artifacts = files.map(file => file.path);
  return { scoped, output, outputFile: path.join(directory, "source-understanding.json") };
}

test("result reads the owned accepted bytes and actual usage after active workspace changes", async t => {
  const f = await fixture(t);
  await f.runtime.dispatch(f.request);
  const { output } = await acceptedFiles(f);
  f.project.workspaceDir = path.join(f.project.baseDir, "different-active-workspace");
  const result = await f.runtime.readResult({ ...f.request, runId: "run-one", sessionId: "session-one" });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.output, output);
  assert.equal(result.usage.inputTokens, 130);
  assert.equal(result.usage.modelId, "deepseek-v4-pro");
});

test("changed, linked or unreceipted source outputs never become a completed result", async t => {
  const f = await fixture(t);
  await f.runtime.dispatch(f.request);
  const { outputFile } = await acceptedFiles(f);
  const identity = { ...f.request, runId: "run-one", sessionId: "session-one" };
  await writeFile(outputFile, '{"summary":"changed"}');
  await assert.rejects(f.runtime.readResult(identity), { code: "source_understanding_receipt_changed" });
  await rm(outputFile);
  const outside = path.join(f.project.rootDir, "outside.json");
  await writeFile(outside, '{}');
  await symlink(outside, outputFile);
  await assert.rejects(f.runtime.readResult(identity));
  f.state.runs[0].artifacts = [];
  await assert.rejects(f.runtime.readResult(identity), { code: "source_understanding_receipt_invalid" });
});

test("a settled receipt with missing token accounting cannot become source usage", async t => {
  const f = await fixture(t);
  await f.runtime.dispatch(f.request);
  await acceptedFiles(f);
  const summary = f.dependencies.usageLedger.summaryRun;
  f.dependencies.usageLedger.summaryRun = async (...args) => ({ ...await summary(...args), incompleteUsageCalls: 1 });
  await assert.rejects(f.runtime.readResult({ ...f.request, runId: "run-one", sessionId: "session-one" }), { code: "source_understanding_usage_invalid" });
});

test("a replaced source-directory ancestor cannot redirect a receipt read outside its owned tree", async t => {
  const f = await fixture(t);
  await f.runtime.dispatch(f.request);
  const { scoped } = await acceptedFiles(f);
  const sourceDirectory = path.dirname(scoped.workspaceDir);
  const replacement = path.join(f.project.baseDir, "replacement-source-directory");
  await rename(sourceDirectory, replacement);
  await symlink(replacement, sourceDirectory);
  await assert.rejects(f.runtime.readResult({ ...f.request, runId: "run-one", sessionId: "session-one" }), { code: "path_forbidden" });
});

test("AgentRunStore recovery passes the durable source workspace into the actual monitor after restart", async t => {
  const f = await fixture(t);
  await f.runtime.dispatch(f.request);
  await mkdir(f.project.metaDir, { recursive: true });
  const session = { sessionId: "session-one", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
  const sessions = { get: async () => session };
  const first = new AgentRunStore(sessions, { model: "deepseek/deepseek-v4-pro", id: () => "run-one" });
  await first.createRun(f.project, session, { dispatchId: f.request.dispatchId });
  const observed = [];
  const recovered = new AgentRunStore(sessions, { model: "deepseek/deepseek-v4-pro", monitorMaxPolls: 1,
    monitorIntervalMs: 1, resolveRunProject: (project, run) => f.runtime.resolveRunProject(project, run),
    readSessionHistory: async project => { observed.push(project.workspaceDir); return []; },
  });
  const changed = { ...f.project, activeWorkspace: "replacement", workspaceDir: path.join(f.project.baseDir, "replacement") };
  await recovered.recover(changed);
  await Promise.all([...recovered.monitors.values()].map(monitor => monitor.promise));
  assert.ok(observed.length > 0);
  assert.ok(observed.every(root => root === path.join(f.project.baseDir, f.state.bound.artifactDirectory)));
  assert.equal(await f.runtime.resolveRunProject(changed, { id: "unbound", agentId: "source-understanding" }), null);
  f.state.bound.sourceStatus = "canceled";
  assert.equal(await f.runtime.resolveRunProject(changed, f.state.runs[0]), null);
  const ordinary = { id: "ordinary", agentId: "clinical-evidence-synthesis" };
  assert.equal(await f.runtime.resolveRunProject(changed, ordinary), changed);
});

for (const entry of ["adoptRunningRuns", "existingDispatch", "adoptRuntimeTurns"]) {
  for (const denied of [false, true]) test(`${entry} ${denied ? "refuses denied source ownership" : "resumes the saved source workspace"}`, async t => {
    const f = await fixture(t);
    await f.runtime.dispatch(f.request);
    await mkdir(f.project.metaDir, { recursive: true });
    const session = { sessionId: "session-one", mode: "specialist", agentId: "source-understanding",
      agentVersion: "1.0.0", runtimeAgent: "evimed-source-understanding" };
    const sessions = { get: async () => session };
    const creator = new AgentRunStore(sessions, { model: "deepseek/deepseek-v4-pro", id: () => "run-one" });
    await creator.reserveRun(f.project, session, { dispatchId: f.request.dispatchId, kernelRequestIds: ["request-one"] });
    const observed = [];
    let resolutions = 0;
    const restarted = new AgentRunStore(sessions, { model: "deepseek/deepseek-v4-pro", monitorMaxPolls: 1,
      monitorIntervalMs: 1, resolveRunProject: (project, run) => {
        resolutions++;
        return f.runtime.resolveRunProject(project, run);
      },
      readSessionHistory: async project => { observed.push(project.workspaceDir); return []; },
    });
    const changed = { ...f.project, activeWorkspace: "replacement", workspaceDir: path.join(f.project.baseDir, "replacement") };
    if (denied) {
      f.state.bound.sourceStatus = "canceled";
      f.state.bound.recoverable = false;
    }
    if (entry === "adoptRunningRuns") {
      const result = await restarted.adoptRunningRuns([changed]);
      assert.equal(result.adopted, denied ? 0 : 1);
    } else if (entry === "existingDispatch") {
      await restarted.existingDispatch(changed, (await restarted.list(changed))[0]);
    } else {
      await restarted.adoptRuntimeTurns(changed, session.sessionId, {
        sessionId: session.sessionId, turns: [{ turn: 1, startSeq: 1, time: Date.now() }],
        messages: [{ seq: 1, turnStartSeq: 1, role: "user", source: "user", sourceRequestId: "request-one",
          parts: [{ type: "text", text: "Read the frozen source." }] }],
      });
    }
    await Promise.all([...restarted.monitors.values()].map(monitor => monitor.promise));
    assert.ok(resolutions > 0, "the actual recovery entry must consult durable ownership");
    if (denied) {
      assert.deepEqual(observed, [], "denied ownership must precede history reads and reconciliation");
      assert.equal(restarted.monitors.size, 0);
      assert.equal((await restarted.list(changed))[0].dispatchStatus, "dispatching");
      assert.equal((await restarted.list(changed))[0].status, "running");
    } else {
      assert.ok(observed.length > 0);
      assert.ok(observed.every(root => root === path.join(f.project.baseDir, f.state.bound.artifactDirectory)));
    }
  });
}
