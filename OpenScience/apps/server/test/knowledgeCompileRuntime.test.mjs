import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { carriesPlatformContext } from "@evimed/domain";
import { UNCAPPED_CNY } from "../src/boundedRunBudget.mjs";
import { createKnowledgeCompileRuntime, knowledgeCompileBudget, knowledgeCompileDispatchId, knowledgeRunProject } from "../src/knowledgeCompileRuntime.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "knowledge-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const homeRoot = path.join(root, "evimed-knowledge");
  const home = { id: "evimed-knowledge", userId: "user-one", rootDir: homeRoot, baseDir: path.join(homeRoot, "workspace"),
    workspaceDir: path.join(homeRoot, "workspace"), metaDir: path.join(homeRoot, ".openscience"), activeWorkspace: "" };
  await mkdir(home.baseDir, { recursive: true });
  const dispatchId = knowledgeCompileDispatchId("project-one", 1);
  const request = { userId: "user-one", dispatchId, input: { schemaVersion: 1, sources: [{ sourceId: `src_${"a".repeat(32)}`, text: "Preserved text" }], pages: [] },
    files: [{ rel: `sources/src_${"a".repeat(32)}.txt`, text: "Preserved text" }, { rel: "pages/afib.md", text: "# Afib\n" }],
    question: "Compile the frozen documents." };
  const calls = [];
  const state = { runs: [], scope: null, wasYielded: false };
  const config = { knowledgePagesRunLimitCny: 2, knowledgePagesDailyLimitCny: 10, knowledgePagesWeeklyLimitCny: 40, userDailySpendLimit: 5, userWeeklySpendLimit: 50,
    deepseekModel: "deepseek-v4-flash", modelGatewaySigningSecret: "fixture-signing-secret-at-least-32-characters" };
  const dependencies = {
    config,
    store: { userById: async () => ({ id: "user-one" }), requireProject: async () => home, createProject: async () => {} },
    agentRuns: {
      list: async () => state.runs,
      existingDispatch: async (_project, run) => { calls.push("recover"); return run; },
      scheduleMonitor: () => calls.push("monitor"),
      cancelSession: async (_project, sessionId) => { calls.push(`cancel-ledger:${sessionId}`); },
      dispatch: async (scoped, args, send) => {
        calls.push("dispatch");
        assert.equal(scoped.id, home.id, "the run is dispatched in the knowledge project");
        assert.equal(scoped.workspaceDir, knowledgeRunProject(home, dispatchId).workspaceDir);
        const run = { id: "run-one", sessionId: args.sessionId, dispatchId: args.dispatchId, status: "running", artifacts: [], kernelRequestIds: ["request-one"] };
        state.runs.push(run);
        try { await send({ sessionId: args.sessionId }, run); } catch (error) { run.status = error.definitivelyRejected ? "failed" : "running"; throw error; }
        return run;
      },
    },
    runtimeManager: {
      reserveBoundedRuntimeSession: async (_project, scope) => { calls.push("reserve"); state.scope = scope; return { id: "session-one" }; },
      dispatchPrompt: async (_project, _session, args) => {
        calls.push("prompt");
        assert.equal(args.allowBounded, true);
        assert.equal(args.model, "deepseek/deepseek-v4-flash");
        assert.match(args.text, new RegExp(`<evimed-knowledge-compile>${dispatchId}</evimed-knowledge-compile>`));
        assert.equal(carriesPlatformContext(args.text.replace(/<evimed-budget-scope>[^<]*<\/evimed-budget-scope>/, "")), true);
        assert.ok(!args.text.includes("Preserved text"), "the documents are files of the run, not part of its brief");
        return { accepted: true };
      },
      boundedRuntimeScope: () => state.scope,
      endBoundedRuntime: async (_project, id) => { calls.push(`release:${id}`); if (state.scope?.runId === id) state.scope = null; },
      cancelRuntimeSession: async (_project, id) => calls.push(`cancel-kernel:${id}`),
      wasYielded: () => state.wasYielded,
    },
    researchSessions: { put: async () => calls.push("session") },
    registry: Promise.resolve({ get: () => ({ id: "knowledge-compile", version: "1.0.0", runtimeAgent: "evimed-knowledge-compile", skill: "knowledge-compile" }) }),
    usageLedger: {
      assertWithinLimits: async (_user, limits) => calls.push(`budget:${(limits.purposes ?? ["account"]).join()}`),
      summaryRun: async () => ({ currency: "CNY", providerId: "deepseek", modelId: "deepseek-v4-flash", actualCost: 0.04, inputTokens: 900, outputTokens: 120, settledCalls: 2, reservedCalls: 0 }),
    },
    prepareContext: async (scoped) => { calls.push("prepare"); assert.equal(scoped.baseDir, scoped.workspaceDir); return { system: "managed context" }; },
  };
  return { home, request, state, calls, dependencies, dispatchId, runtime: createKnowledgeCompileRuntime(dependencies) };
}

test("the compile's own caps count its own spend; the account's caps cover everything", () => {
  assert.deepEqual(knowledgeCompileBudget({ knowledgePagesRunLimitCny: 2, knowledgePagesDailyLimitCny: 10, knowledgePagesWeeklyLimitCny: 40, userDailySpendLimit: 5, userWeeklySpendLimit: 50 }), {
    own: { dailyLimit: 10, weeklyLimit: 40, purposes: ["knowledge"] }, account: { dailyLimit: 5, weeklyLimit: 50 }, scope: { dailyLimit: 5, weeklyLimit: 50, runLimit: 2 } });
  assert.deepEqual(knowledgeCompileBudget({}).scope, { dailyLimit: UNCAPPED_CNY, weeklyLimit: UNCAPPED_CNY, runLimit: UNCAPPED_CNY });
  assert.throws(() => knowledgeCompileBudget({ knowledgePagesRunLimitCny: -1 }), { code: "knowledge_budget_invalid" });
});

test("a run's workspace is one directory directly under the knowledge project, named from the dispatch id alone", () => {
  const home = { baseDir: "/tmp/home/workspace", id: "evimed-knowledge" };
  const one = knowledgeRunProject(home, knowledgeCompileDispatchId("project-one", 1));
  assert.equal(path.dirname(one.workspaceDir), home.baseDir);
  assert.match(one.activeWorkspace, /^kc-[a-f0-9]{24}$/);
  assert.equal(knowledgeRunProject(home, knowledgeCompileDispatchId("project-one", 1)).workspaceDir, one.workspaceDir);
  assert.notEqual(knowledgeRunProject(home, knowledgeCompileDispatchId("project-one", 2)).workspaceDir, one.workspaceDir);
  assert.notEqual(knowledgeRunProject(home, knowledgeCompileDispatchId("project-two", 1)).workspaceDir, one.workspaceDir);
  assert.throws(() => knowledgeRunProject(home, "../../etc"), { code: "knowledge_run_scope_unavailable" });
});

test("a dispatch writes the input and the files once the run exists, asks both budgets and sends one prompt", async (t) => {
  const f = await fixture(t);
  const identity = await f.runtime.dispatch(f.request);
  assert.deepEqual(identity, { runId: "run-one", sessionId: "session-one", dispatchId: f.dispatchId });
  assert.equal(f.calls.filter((value) => value === "prompt").length, 1);
  assert.ok(f.calls.indexOf("dispatch") < f.calls.indexOf("prepare") && f.calls.indexOf("prepare") < f.calls.indexOf("prompt"));
  assert.ok(f.calls.includes("budget:knowledge") && f.calls.includes("budget:account"));
  const scoped = knowledgeRunProject(f.home, f.dispatchId);
  assert.deepEqual(JSON.parse(await readFile(path.join(scoped.workspaceDir, "knowledge-compile-input.json"), "utf8")), f.request.input);
  assert.equal(await readFile(path.join(scoped.workspaceDir, "pages", "afib.md"), "utf8"), "# Afib\n");
  assert.equal(await readFile(path.join(scoped.workspaceDir, "sources", `src_${"a".repeat(32)}.txt`), "utf8"), "Preserved text");
  assert.equal(f.state.scope.runId, f.dispatchId);
  assert.equal(f.state.scope.runLimit, 2);
  assert.equal(f.state.scope.dailyLimit, 5);
});

test("a dispatch that already exists is adopted and neither reserves nor pays again", async (t) => {
  const f = await fixture(t);
  await f.runtime.dispatch(f.request);
  f.calls.length = 0;
  assert.equal((await f.runtime.dispatch(f.request)).runId, "run-one");
  assert.deepEqual(f.calls.filter((value) => ["reserve", "prompt", "dispatch"].includes(value) || value.startsWith("budget")), []);
  assert.ok(f.calls.includes("recover") && f.calls.includes("monitor"));
});

test("another round running makes this one wait; a cap or an oversized input spends nothing", async (t) => {
  const f = await fixture(t);
  f.state.runs.push({ id: "other", dispatchId: knowledgeCompileDispatchId("other", 1), status: "running" });
  await assert.rejects(f.runtime.dispatch(f.request), { code: "runtime_busy" });
  f.state.runs.length = 0;
  f.dependencies.usageLedger.assertWithinLimits = async () => { throw Object.assign(new Error("no budget"), { code: "usage_budget_exceeded" }); };
  await assert.rejects(createKnowledgeCompileRuntime(f.dependencies).dispatch(f.request), { code: "usage_budget_exceeded" });
  assert.equal(f.calls.includes("reserve"), false);
  const g = await fixture(t);
  await assert.rejects(g.runtime.dispatch({ ...g.request, input: { text: "x".repeat(8 * 1024 * 1024) } }), { code: "knowledge_input_too_large" });
  assert.equal(g.calls.includes("reserve"), false);
});

test("a launch that failed behind a researcher's start waits; behind anything else it fails and leaves no workspace", async (t) => {
  for (const yielded of [true, false]) {
    const f = await fixture(t);
    f.state.wasYielded = yielded;
    f.dependencies.researchSessions.put = async () => { throw Object.assign(new Error("went away"), { code: "runtime_session_error" }); };
    await assert.rejects(createKnowledgeCompileRuntime(f.dependencies).dispatch(f.request), { code: yielded ? "runtime_yielded" : "runtime_session_error" });
    assert.ok(f.calls.includes(`release:${f.dispatchId}`));
    assert.deepEqual(await readdir(f.home.baseDir), [], "the workspace of a run that was never recorded is removed");
  }
});

/** @param {any} f */
async function accepted(f, { receipt = true } = {}) {
  const scoped = knowledgeRunProject(f.home, f.dispatchId);
  const directory = path.join(scoped.workspaceDir, "deliverables", "wiki");
  await mkdir(directory, { recursive: true });
  const patch = { schemaVersion: 1, pages: [] };
  const files = [];
  for (const [name, value] of [["knowledge-compile-input.json", f.request.input], ["wiki-patch.json", patch]]) {
    const content = Buffer.from(JSON.stringify(value));
    const relative = `deliverables/wiki/${name}`;
    await writeFile(path.join(scoped.workspaceDir, relative), content);
    files.push({ path: relative, bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") });
  }
  if (receipt) {
    await writeFile(path.join(scoped.workspaceDir, "delivery-receipt.json"), JSON.stringify({ formatVersion: 1, runId: "kernel-run-one", bundleVersion: "1.0.0", domainVersion: "1.0.0",
      entries: [{ deliverableId: "wiki", contractKind: "knowledge-wiki-patch", capability: "knowledge-compile", files, acceptedAt: new Date().toISOString(), attempt: 1, notices: [] }] }));
  }
  f.state.runs[0].status = "succeeded";
  f.state.runs[0].artifacts = files.map((file) => file.path);
  return patch;
}

test("a finished run's patch is read from its own workspace, with what the gateway settled; a missing receipt is only a label", async (t) => {
  const f = await fixture(t);
  await f.runtime.dispatch(f.request);
  const identity = { userId: "user-one", runId: "run-one", sessionId: "session-one", dispatchId: f.dispatchId };
  assert.deepEqual(await f.runtime.readResult(identity), { status: "pending" });
  const patch = await accepted(f, { receipt: false });
  const result = await f.runtime.readResult(identity);
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.patch, patch);
  assert.equal(result.verification, "unverified", "no receipt: delivered, labelled");
  assert.equal(result.usage.inputTokens, 900);
  await accepted(f);
  const vouched = await f.runtime.readResult(identity);
  assert.equal(vouched.verification, undefined, "a receipt that names the delivered bytes vouches for them");
  f.state.runs[0].artifacts = [];
  await rm(path.join(knowledgeRunProject(f.home, f.dispatchId).workspaceDir, "deliverables"), { recursive: true });
  await assert.rejects(f.runtime.readResult(identity), { code: "knowledge_output_missing" });
});

test("a run a researcher's start ended reads as yielded; an ordinary failure does not", async (t) => {
  const f = await fixture(t);
  await f.runtime.dispatch(f.request);
  const identity = { userId: "user-one", runId: "run-one", sessionId: "session-one", dispatchId: f.dispatchId };
  f.state.runs[0].status = "canceled";
  f.state.runs[0].errorCode = "runtime_yielded";
  assert.deepEqual(await f.runtime.readResult(identity), { status: "canceled", yielded: true });
  f.state.runs[0].status = "failed";
  f.state.runs[0].errorCode = "runtime_error";
  assert.deepEqual(await f.runtime.readResult(identity), { status: "failed" });
});

test("a late completion or cancellation cannot release a newer scope, and only the knowledge project's own runs are touched", async (t) => {
  const f = await fixture(t);
  await f.runtime.dispatch(f.request);
  f.state.scope = { runId: "someone-else" };
  f.calls.length = 0;
  assert.equal(await f.runtime.complete(f.home, f.state.runs[0]), true);
  assert.equal(f.calls.some((value) => value.startsWith("release:")), false);
  assert.equal(await f.runtime.complete({ id: "project-one" }, f.state.runs[0]), false);
  assert.equal(await f.runtime.complete(f.home, { dispatchId: "source-understanding-x" }), false);
  f.state.scope = { runId: f.dispatchId };
  await f.runtime.complete(f.home, f.state.runs[0]);
  assert.deepEqual(f.calls, [`release:${f.dispatchId}`]);
  assert.equal((await f.runtime.resolveRunProject({ id: "project-one", baseDir: "/x" }, f.state.runs[0])).id, "project-one");
  assert.equal((await f.runtime.resolveRunProject(f.home, f.state.runs[0])).workspaceDir, knowledgeRunProject(f.home, f.dispatchId).workspaceDir);
});
