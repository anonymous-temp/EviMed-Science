// What the owner of background work does when a researcher's start took its
// runtime back (`RuntimeManager.makeRoomFor`, `RUNTIME_YIELDED_CODE`, 2026-10-04).
//
// The retirement is the platform's doing, so it is never the work's failure: the
// learning job waits and the step runs again under the next attempt id, and a
// document's understanding run is released so the next claim launches a new one
// for the same frozen capture. Counted as a failure, a lesson loses an attempt
// and an uploaded document is marked failed and waits for 「重新分析」.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LEARNING_PROJECT_ID, RUNTIME_YIELDED_CODE } from "../src/internalProjects.mjs";
import { createLearningRuntime } from "../src/learningRuntime.mjs";
import { DEFERRED_LEARNING_ERRORS } from "../src/methodConsolidation.mjs";
import { SourceService, understandingDispatchId } from "../src/sourceService.mjs";
import { SourceUnderstandingRuns } from "../src/sourceUnderstandingRuns.mjs";

const SOURCE_ID = `src_${"a".repeat(32)}`;

test("the learning loop names the retirement as a wait, with room to ask again", () => {
  assert.equal(DEFERRED_LEARNING_ERRORS.has(RUNTIME_YIELDED_CODE), true);
  assert.ok(DEFERRED_LEARNING_ERRORS.get(RUNTIME_YIELDED_CODE) >= 30_000);
});

/** @param {any[]} ledger @param {any} [runtimeManager] */
function learningWith(ledger, runtimeManager = {}) {
  const project = { id: LEARNING_PROJECT_ID, userId: "u1", rootDir: "/tmp/unused", baseDir: "/tmp/unused", workspaceDir: "/tmp/unused/workspace" };
  return createLearningRuntime({
    config: {},
    store: { async userById(id) { return { id }; }, async requireProject() { return project; }, async createProject() {} },
    agentRuns: { async list() { return ledger; }, async existingDispatch() {}, scheduleMonitor() {} },
    runtimeManager, researchSessions: {}, registry: Promise.resolve(new Map()), usageLedger: {}, prepareContext: async () => ({}),
  });
}

test("a learning step whose run a researcher's start ended is a wait, whatever status the run was closed with", async () => {
  const identity = { userId: "u1", projectId: "default", runId: "run_1", sessionId: "s1", dispatchId: "method-distillation-abc" };
  for (const status of ["canceled", "failed"]) {
    const runtime = learningWith([{ ...identity, id: "run_1", status, errorCode: RUNTIME_YIELDED_CODE }]);
    await assert.rejects(runtime.readResult({ ...identity, capabilityId: "method-distillation" }),
      (error) => error.code === RUNTIME_YIELDED_CODE && error.status === 409, status);
  }
  // Every other end keeps reading as it did: the platform's plain cancel is still a cancel.
  const plain = learningWith([{ ...identity, id: "run_1", status: "canceled", errorCode: "runtime_canceled" }]);
  assert.deepEqual(await plain.readResult({ ...identity, capabilityId: "method-distillation" }), { status: "canceled" });
});

test("a learning launch that failed behind a retirement is a wait; one that did not is the failure it was", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evimed-learning-yield-"));
  try {
    const project = { id: LEARNING_PROJECT_ID, userId: "u1", rootDir: root, baseDir: root, workspaceDir: path.join(root, "workspace"), quotaBytes: 10_000_000 };
    const request = { job: { userId: "u1", projectId: "default", payload: {} }, userId: "u1", projectId: "default",
      dispatchId: "method-distillation-0123abcd", capabilityId: "method-distillation", contractKind: "method-candidate", input: {}, question: "q" };
    for (const [yielded, expected] of [[true, RUNTIME_YIELDED_CODE], [false, "fixture_stop"]]) {
      const runtime = createLearningRuntime({
        config: { maxProjectBytes: 10_000_000 },
        store: { async userById(id) { return { id }; }, async requireProject() { return project; }, async createProject() {} },
        agentRuns: { async list() { return []; }, async existingDispatch() {}, scheduleMonitor() {} },
        runtimeManager: {
          async reserveBoundedRuntimeSession() { throw Object.assign(new Error("stop"), { code: "fixture_stop" }); },
          wasYielded: () => yielded,
        },
        researchSessions: {}, usageLedger: { async assertWithinLimits() { return { allowed: true }; } },
        registry: Promise.resolve(new Map([["method-distillation", { id: "method-distillation", version: "1.0.0", runtimeAgent: "evimed-method-distillation" }]])),
        prepareContext: async () => ({}),
      });
      await assert.rejects(runtime.dispatch(request), { code: expected });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ——— Source understanding ———

test("a document's understanding run is a new dispatch of the same capture after each retirement", () => {
  const first = understandingDispatchId(SOURCE_ID, 3);
  assert.match(first, /^source-understanding-[a-f0-9]{32}$/);
  assert.equal(understandingDispatchId(SOURCE_ID, 3, 0), first, "unreleased, the id is what it always was");
  assert.equal(understandingDispatchId(SOURCE_ID, 3, 1), `${first}-r1`);
  assert.equal(understandingDispatchId(SOURCE_ID, 3, 2), `${first}-r2`);
  assert.notEqual(understandingDispatchId(SOURCE_ID, 4), first, "another generation is another run");
  for (const bad of [-1, 1.5, Number.NaN]) assert.equal(understandingDispatchId(SOURCE_ID, 3, bad), first, String(bad));
});

/** One source record at a generation and relaunch count, and the part of the service these methods use. */
function sourceFixture({ relaunches = 0, analysis = {} } = {}) {
  const job = { id: "job-1", userId: "u1", projectId: "p1", payload: { sourceId: SOURCE_ID, sourceGeneration: 3 } };
  const current = { revision: 7, payload: { generation: 3, status: "parsing", analysis: { generation: 3, phase: "understanding", ...(relaunches ? { relaunches } : {}), ...analysis } } };
  const service = {
    /** @param {string} _userId @param {string} _sourceId @param {any} _job @param {(current: any) => any} prepare */
    async mutateIngestion(_userId, _sourceId, _job, prepare) { return { ...current, payload: prepare(current) }; },
  };
  return { job, current, service };
}

test("a retired understanding run is released: its binding goes, the relaunch count rises, the capture stays", async () => {
  const dispatchId = understandingDispatchId(SOURCE_ID, 3);
  const launch = { sessionId: "s1", dispatchId, workspaceName: "", artifactDirectory: "knowledge-base/.evimed-derived/x" };
  const { job, current, service } = sourceFixture({ analysis: { launch, run: { id: "run_1", ...launch }, unitCount: 12, textSha256: "t" } });
  const released = await SourceService.prototype.releaseYieldedUnderstanding.call(service, job, { dispatchId });
  assert.equal(released.payload.analysis.relaunches, 1);
  assert.equal(released.payload.analysis.run, undefined);
  assert.equal(released.payload.analysis.launch, undefined);
  assert.deepEqual({ generation: released.payload.analysis.generation, unitCount: released.payload.analysis.unitCount, textSha256: released.payload.analysis.textSha256 },
    { generation: 3, unitCount: 12, textSha256: "t" }, "the frozen capture is untouched");
  assert.equal(released.payload.status, "parsing", "the source is still being analysed, not failed");
  // Releasing what is already released changes nothing: the same payload comes back, so no revision is written.
  const again = sourceFixture({ relaunches: 1 });
  const unchanged = await SourceService.prototype.releaseYieldedUnderstanding.call(again.service, again.job, { dispatchId });
  assert.equal(unchanged.payload, again.current.payload);
  // A launch intent with no run yet (the retirement came before the run was recorded) is released the same way.
  const launchOnly = sourceFixture({ analysis: { launch } });
  const freed = await SourceService.prototype.releaseYieldedUnderstanding.call(launchOnly.service, launchOnly.job, { dispatchId });
  assert.equal(freed.payload.analysis.launch, undefined);
  assert.equal(freed.payload.analysis.relaunches, 1);
  assert.equal(current.payload.analysis.relaunches, undefined, "the stored record is not edited in place");
});

test("a launch is bound only under the id the source's relaunch count names", async () => {
  const base = understandingDispatchId(SOURCE_ID, 3);
  const launch = (dispatchId) => ({ sessionId: "s1", dispatchId, workspaceName: "", artifactDirectory: "knowledge-base/.evimed-derived/x" });
  for (const [relaunches, dispatchId, ok] of [[0, base, true], [1, `${base}-r1`, true], [1, base, false], [0, `${base}-r1`, false], [2, `${base}-r1`, false]]) {
    const { job, service } = sourceFixture({ relaunches });
    const bind = SourceService.prototype.bindUnderstandingLaunch.call(service, job, launch(dispatchId));
    if (ok) assert.equal((await bind).payload.analysis.launch.dispatchId, dispatchId);
    else await assert.rejects(bind, { code: "source_run_binding_invalid" }, `${relaunches} / ${dispatchId}`);
  }
  // Another source's, or a malformed, id is refused before the record is read.
  for (const dispatchId of [understandingDispatchId(`src_${"b".repeat(32)}`, 3), `${base}-r0`, `${base}-x`, "", undefined]) {
    const { job, service } = sourceFixture();
    await assert.rejects(SourceService.prototype.bindUnderstandingLaunch.call(service, job, launch(dispatchId)), { code: "source_run_binding_invalid" }, String(dispatchId));
    await assert.rejects(SourceService.prototype.bindUnderstandingRun.call(service, job, { ...launch(dispatchId), runId: "run_1" }), { code: "source_run_binding_invalid" }, String(dispatchId));
  }
  const { job, service } = sourceFixture({ relaunches: 1, analysis: { launch: launch(`${base}-r1`) } });
  const bound = await SourceService.prototype.bindUnderstandingRun.call(service, job, { ...launch(`${base}-r1`), runId: "run_9" });
  assert.equal(bound.payload.analysis.run.dispatchId, `${base}-r1`);
});

/** @param {any} overrides */
function understandingRequest(overrides = {}) {
  const calls = [];
  const runs = new SourceUnderstandingRuns({
    dispatch: async (request) => { calls.push({ dispatch: request.dispatchId }); return { runId: "run_1", sessionId: "s1", dispatchId: request.dispatchId }; },
    readResult: async () => ({ status: "canceled", yielded: true }),
    releaseYielded: async (request) => { calls.push({ release: request.dispatchId, job: request.job.id }); },
    ...overrides,
  });
  const source = { id: SOURCE_ID, payload: { generation: 3, docType: "journal-article", depth: "structured", analysis: {} } };
  const parsed = { input: { depth: "structured", docType: "journal-article", text: "t", units: [] } };
  return { runs, calls, request: { job: { id: "job-1", userId: "u1", projectId: "p1" }, source, parsed } };
}

test("a document's understanding run that a researcher's start ended is released and the job told to wait", async () => {
  const { runs, calls, request } = understandingRequest();
  await assert.rejects(runs.execute(request), (error) => error.code === RUNTIME_YIELDED_CODE && error.status === 409);
  const base = understandingDispatchId(SOURCE_ID, 3);
  assert.deepEqual(calls, [{ dispatch: base }, { release: base, job: "job-1" }]);
});

test("the run after a release is dispatched under the next id, and an unreleased source keeps its first", async () => {
  const { runs, calls, request } = understandingRequest({ readResult: async () => ({ status: "pending" }) });
  request.source.payload.analysis.relaunches = 2;
  const result = await runs.execute(request);
  assert.equal(result.state, "pending");
  assert.deepEqual(calls, [{ dispatch: `${understandingDispatchId(SOURCE_ID, 3)}-r2` }]);
});

test("without a way to release the run, a retired understanding reads as the failure it would otherwise be", async () => {
  const { runs, request } = understandingRequest({ releaseYielded: null });
  await assert.rejects(runs.execute(request), { code: "source_understanding_run_failed" });
  const plain = understandingRequest({ readResult: async () => ({ status: "canceled" }) });
  await assert.rejects(plain.runs.execute(plain.request), { code: "source_understanding_run_failed" });
  assert.deepEqual(plain.calls.map((call) => Object.keys(call)[0]), ["dispatch"], "an ordinary cancel releases nothing");
});
