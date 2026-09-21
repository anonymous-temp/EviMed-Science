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
