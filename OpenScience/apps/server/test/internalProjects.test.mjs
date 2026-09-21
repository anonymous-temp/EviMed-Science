import assert from "node:assert/strict";
import test from "node:test";

import { LEARNING_PROJECT_ID, isInternalProject } from "../src/internalProjects.mjs";
import { createLearningRuntime } from "../src/learningRuntime.mjs";
import { RuntimeManager } from "../src/runtimeManager.mjs";

// 2026-09-21: a learning step ran in the researcher's own project, held its
// runtime, and the conversation answered 423 for the minutes it took — and,
// because nothing released it, until the container was stopped by hand.

test("the platform's background projects are named, and nothing else is", () => {
  assert.equal(isInternalProject(LEARNING_PROJECT_ID), true);
  assert.equal(isInternalProject("eval-method-release"), true, "the paired evaluation's own project");
  for (const id of ["default", "0921a", "evimed-learning-notes", "eval-methods", "my-eval-method-release"]) {
    assert.equal(isInternalProject(id), false, id);
  }
});

test("a background runtime never takes one of the researcher's runtime slots", () => {
  const manager = new RuntimeManager({ maxRunningRuntimesPerUser: 2, maxRunningRuntimes: 8 });
  manager.runtimes.set(`u1:${LEARNING_PROJECT_ID}`, {});
  manager.runtimes.set("u1:eval-method-release", {});
  manager.runtimes.set("u1:default", {});
  assert.equal(manager.runtimeCountForUser("u1"), 1, "only the researcher's own project counts");
  assert.doesNotThrow(() => manager.enforceRuntimeCapacity({ userId: "u1", id: "second" }), "a second project still opens");
  assert.equal(manager.runtimeCount(), 3, "the global ceiling still counts them");
});

test("a learning step runs in the account's learning project, made on first use, never the lesson's own project", async () => {
  /** @type {string[]} */
  const created = [];
  const projects = new Map([["default", { id: "default", userId: "u1", baseDir: "/tmp/p/default", workspaceDir: "/tmp/p/default/ws" }]]);
  const store = {
    async userById(id) { return { id }; },
    async requireProject(_user, id) {
      const project = projects.get(id);
      if (!project) throw Object.assign(new Error("missing"), { code: "project_not_found", status: 404 });
      return project;
    },
    async createProject(_user, id) {
      created.push(id);
      projects.set(id, { id, userId: "u1", baseDir: `/tmp/p/${id}`, workspaceDir: `/tmp/p/${id}/ws` });
    },
  };
  /** @type {any[]} */
  const listed = [];
  const runtime = createLearningRuntime({
    config: {}, store, runtimeManager: {}, researchSessions: {}, registry: Promise.resolve(new Map()), usageLedger: null,
    prepareContext: async () => ({}),
    agentRuns: {
      async list(project) { listed.push(project.id); return [{ id: "run_1", sessionId: "s1", dispatchId: "method-distillation-abc", status: "running" }]; },
      async existingDispatch() {},
      scheduleMonitor() {},
    },
  });
  const identity = await runtime.dispatch({
    job: { userId: "u1", projectId: "default", payload: {} }, userId: "u1", projectId: "default",
    dispatchId: "method-distillation-abc", capabilityId: "method-distillation", contractKind: "method-candidate", input: {}, question: "q",
  });
  assert.equal(identity.runId, "run_1");
  assert.deepEqual(created, [LEARNING_PROJECT_ID]);
  assert.deepEqual(listed, [LEARNING_PROJECT_ID], "the ledger read is the learning project's, not the lesson's project");
});

test("the gateway marker of a learning step names the project its runtime belongs to", async () => {
  // The first learning runs in the learning project failed in a second: the
  // marker named the lesson's project, the runtime belonged to the learning
  // project, and the gateway refused every call (model_gateway_budget_scope_invalid).
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/learningRuntime.mjs", import.meta.url), "utf8");
  const marker = source.slice(source.indexOf("issueModelGatewayBudgetMarker({"), source.indexOf("issueModelGatewayBudgetMarker({") + 400);
  assert.match(marker, /projectId: project\.id/);
  assert.doesNotMatch(marker, /projectId: job\.projectId/);
});

test("a learning step writes its input at the learning project's root, on a workspace cleared of the last step", async () => {
  // The runtime controller mounts a project's workspace root; a step scoped to
  // a subdirectory never found its own input (2026-09-21).
  const { mkdtemp, mkdir, writeFile, readdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const root = await mkdtemp(path.join(tmpdir(), "evimed-learning-"));
  try {
    const workspaceDir = path.join(root, "workspace");
    await mkdir(path.join(workspaceDir, "deliverables", "method-candidate"), { recursive: true });
    await writeFile(path.join(workspaceDir, "deliverables", "method-candidate", "SKILL.md"), "the last step's method");
    await writeFile(path.join(workspaceDir, "distillation-input.json"), "{}");
    const project = { id: LEARNING_PROJECT_ID, userId: "u1", rootDir: root, baseDir: root, workspaceDir, quotaBytes: 10_000_000 };
    const runtime = createLearningRuntime({
      config: { maxProjectBytes: 10_000_000 },
      store: { async userById(id) { return { id }; }, async requireProject() { return project; }, async createProject() {} },
      agentRuns: { async list() { return []; } },
      runtimeManager: { async reserveBoundedRuntimeSession() { throw Object.assign(new Error("stop here"), { code: "fixture_stop" }); } },
      researchSessions: {}, usageLedger: { async assertWithinLimits() { return { allowed: true }; } },
      registry: Promise.resolve(new Map([["method-distillation", { id: "method-distillation", version: "1.0.0", runtimeAgent: "evimed-method-distillation" }]])),
      prepareContext: async () => ({}),
    });
    await assert.rejects(runtime.dispatch({
      job: { userId: "u1", projectId: "default", payload: {} }, userId: "u1", projectId: "default",
      dispatchId: "method-distillation-0123abcd", capabilityId: "method-distillation", contractKind: "method-candidate",
      input: { schemaVersion: 1, trigger: "delivered" }, question: "q",
    }), { code: "fixture_stop" });
    assert.deepEqual((await readdir(workspaceDir)).sort(), ["distillation-input.json"], "the last step's files are gone");
    const { readFile } = await import("node:fs/promises");
    assert.match(await readFile(path.join(workspaceDir, "distillation-input.json"), "utf8"), /"trigger":"delivered"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed learning dispatch is retried under the next attempt id; a working one is adopted", async () => {
  // Adopting a failed dispatch read the same failure back to every re-queued
  // job: one bad run was a lesson lost for good (2026-09-21).
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const root = await mkdtemp(path.join(tmpdir(), "evimed-learning-"));
  try {
    const project = { id: LEARNING_PROJECT_ID, userId: "u1", rootDir: root, baseDir: root, workspaceDir: path.join(root, "workspace"), quotaBytes: 10_000_000 };
    /** @param {any[]} ledger */
    const runtimeWith = (ledger) => {
      /** @type {string[]} */
      const reserved = [];
      const runtime = createLearningRuntime({
        config: { maxProjectBytes: 10_000_000 },
        store: { async userById(id) { return { id }; }, async requireProject() { return project; }, async createProject() {} },
        agentRuns: { async list() { return ledger; }, async existingDispatch() {}, scheduleMonitor() {} },
        runtimeManager: {
          async reserveBoundedRuntimeSession(_scoped, scope) { reserved.push(scope.runId); throw Object.assign(new Error("stop"), { code: "fixture_stop" }); },
          boundedRuntimeScope() { return null; },
        },
        researchSessions: {}, usageLedger: { async assertWithinLimits() { return { allowed: true }; } },
        registry: Promise.resolve(new Map([["method-distillation", { id: "method-distillation", version: "1.0.0", runtimeAgent: "evimed-method-distillation" }]])),
        prepareContext: async () => ({}),
      });
      return { runtime, reserved };
    };
    const request = { job: { userId: "u1", projectId: "default", payload: {} }, userId: "u1", projectId: "default",
      dispatchId: "method-distillation-0123abcd", capabilityId: "method-distillation", contractKind: "method-candidate", input: {}, question: "q" };

    const failed = runtimeWith([{ id: "run_old", sessionId: "s0", dispatchId: "method-distillation-0123abcd", status: "failed", startedAt: "2026-09-21T04:00:00Z" }]);
    await assert.rejects(failed.runtime.dispatch(request), { code: "fixture_stop" });
    assert.deepEqual(failed.reserved, ["method-distillation-0123abcd-a2"], "a fresh run under the next attempt id");

    const working = runtimeWith([
      { id: "run_old", sessionId: "s0", dispatchId: "method-distillation-0123abcd", status: "failed", startedAt: "2026-09-21T04:00:00Z" },
      { id: "run_new", sessionId: "s1", dispatchId: "method-distillation-0123abcd-a2", status: "running", startedAt: "2026-09-21T04:10:00Z" },
    ]);
    const adopted = await working.runtime.dispatch(request);
    assert.deepEqual(adopted, { runId: "run_new", sessionId: "s1", dispatchId: "method-distillation-0123abcd-a2" });
    assert.deepEqual(working.reserved, [], "a working attempt is never started twice");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a finished bounded run is not held back by a request whose settlement will never arrive", async () => {
  // The first successful distillation had 48 settled calls and one `uncertain`
  // (its stream was cut); both readers waited for the uncertain one to settle,
  // which it never does, so the lesson could never land (2026-09-21).
  const { readFile } = await import("node:fs/promises");
  for (const file of ["../src/learningRuntime.mjs", "../src/sourceUnderstandingRuntime.mjs"]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(source, /if \(usage\.reservedCalls\) return \{ status: "pending"/, file);
    assert.doesNotMatch(source, /usage\.reservedCalls \|\| usage\.uncertain/, file);
  }
});

test("a finished step's result survives the next step's clear, outside the workspace the next run sees", async () => {
  // 2026-09-21: a delivered lesson waited for its usage to settle, the next
  // step emptied the one learning workspace, and the lesson was lost to ENOENT.
  const { createHash } = await import("node:crypto");
  const { mkdtemp, mkdir, writeFile, readdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { RECEIPT_FORMAT_VERSION } = await import("@evimed/domain");
  const root = await mkdtemp(path.join(tmpdir(), "evimed-learning-"));
  try {
    const workspaceDir = path.join(root, "workspace");
    const project = { id: LEARNING_PROJECT_ID, userId: "u1", rootDir: root, baseDir: workspaceDir, workspaceDir,
      metaDir: path.join(root, ".openscience"), quotaBytes: 10_000_000 };
    await mkdir(project.metaDir, { recursive: true });
    await mkdir(path.join(workspaceDir, "deliverables", "lesson"), { recursive: true });
    const files = {
      "deliverables/lesson/SKILL.md": "---\nname: lesson\n---\n\n## Purpose\nA lesson.\n",
      "deliverables/lesson/method-candidate.json": JSON.stringify({ schemaVersion: 1, operation: "no_change", reason: "fixture" }),
    };
    for (const [relative, text] of Object.entries(files)) await writeFile(path.join(workspaceDir, relative), text);
    await writeFile(path.join(workspaceDir, "delivery-receipt.json"), JSON.stringify({
      formatVersion: RECEIPT_FORMAT_VERSION, runId: "run_a", bundleVersion: "b", domainVersion: "d",
      entries: [{ deliverableId: "lesson", contractKind: "method-candidate", capability: "method-distillation",
        files: Object.entries(files).map(([relative, text]) => ({
          path: relative, bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex"),
        })) }],
    }));
    /** @type {any[]} newest first, as `agentRuns.list` returns it */
    const ledger = [{ id: "run_a", sessionId: "s_a", dispatchId: "method-distillation-aaaa", status: "succeeded",
      startedAt: "2026-09-21T05:00:00Z", artifacts: Object.keys(files) }];
    /** @type {string[]} */
    const reserved = [];
    const runtime = createLearningRuntime({
      config: { maxProjectBytes: 10_000_000 },
      store: { async userById(id) { return { id }; }, async requireProject() { return project; }, async createProject() {} },
      agentRuns: { async list() { return ledger; }, async existingDispatch() {}, scheduleMonitor() {} },
      runtimeManager: {
        async reserveBoundedRuntimeSession(_scoped, scope) { reserved.push(scope.runId); throw Object.assign(new Error("stop"), { code: "fixture_stop" }); },
        boundedRuntimeScope() { return null; },
      },
      researchSessions: {},
      usageLedger: {
        async assertWithinLimits() { return { allowed: true }; },
        async summaryRun() { return { settledCalls: 3, reservedCalls: 0, incompleteUsageCalls: 0, modelId: "deepseek-v4-flash" }; },
      },
      registry: Promise.resolve(new Map([["method-distillation", { id: "method-distillation", version: "1.0.0", runtimeAgent: "evimed-method-distillation" }]])),
      prepareContext: async () => ({}),
    });
    const step = (dispatchId) => ({ job: { userId: "u1", projectId: "default", payload: {} }, userId: "u1", projectId: "default",
      dispatchId, capabilityId: "method-distillation", contractKind: "method-candidate", input: {}, question: "q" });

    await assert.rejects(runtime.dispatch(step("method-distillation-bbbb")), { code: "fixture_stop" });
    assert.deepEqual(await readdir(workspaceDir), ["distillation-input.json"], "the next step starts on an empty workspace");
    const read = await runtime.readResult({ userId: "u1", projectId: "default", runId: "run_a", sessionId: "s_a",
      dispatchId: "method-distillation-aaaa", capabilityId: "method-distillation" });
    assert.equal(read.status, "succeeded", "the lesson is read from its archive");
    assert.equal(read.output.candidate.operation, "no_change");

    // A delivery emptied before the archive existed is run again, not adopted
    // into ENOENT for every retry.
    ledger.unshift({ id: "run_c", sessionId: "s_c", dispatchId: "method-distillation-cccc", status: "succeeded",
      startedAt: "2026-09-21T05:30:00Z", artifacts: [] });
    ledger.unshift({ id: "run_d", sessionId: "s_d", dispatchId: "method-distillation-dddd", status: "failed", startedAt: "2026-09-21T05:40:00Z" });
    await assert.rejects(runtime.readResult({ userId: "u1", projectId: "default", runId: "run_c", sessionId: "s_c",
      dispatchId: "method-distillation-cccc", capabilityId: "method-distillation" }), { code: "learning_result_missing" });
    await assert.rejects(runtime.dispatch(step("method-distillation-cccc")), { code: "fixture_stop" });
    assert.deepEqual(reserved, ["method-distillation-bbbb", "method-distillation-cccc-a2"]);
    // …while one whose archive is there is still adopted, never paid for twice.
    assert.deepEqual(await runtime.dispatch(step("method-distillation-aaaa")),
      { runId: "run_a", sessionId: "s_a", dispatchId: "method-distillation-aaaa" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
