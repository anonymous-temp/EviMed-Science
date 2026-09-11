// The memory routes on a deployment that has no database, and the two things
// that must still be true there.
//
// The rest of these routes are exercised against the real store on PostgreSQL
// in `memoryApi.integration.test.mjs`. What is left here is what needs no
// database at all: what the status route says when there is no store, and that
// the memory routes do not depend on the feedback ledger they write to. Both
// used to be covered through an HTTP fake of a separate memory service, which
// after the move would be a fake of nothing.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import { ResearchMemoryStore } from "../src/researchMemory.mjs";

/** The store's surface, at the interface, with no database behind it. The
 *  routes below read and write exactly these three calls. */
function researchMemoryDouble(record) {
  const state = { ...record };
  let deleted = false;
  return {
    configured: true,
    async status() { return { configured: true, connected: true, code: null, structured: true }; },
    async getRecord(_userId, id) {
      if (deleted || id !== state.id) {
        const error = new Error("Memory not found.");
        /** @type {any} */ (error).code = "memory_not_found";
        /** @type {any} */ (error).status = 404;
        throw error;
      }
      return { ...state };
    },
    async upsertRecord(_userId, input) {
      Object.assign(state, input, { version: state.version + 1 });
      return { ...state };
    },
    async deleteRecord() { deleted = true; return true; },
  };
}

test("memory status reports an unconfigured store without pretending to be connected", async () => {
  const store = new ResearchMemoryStore({}, { database: null });
  assert.equal(store.configured, false);
  assert.deepEqual(await store.status(), {
    configured: false,
    connected: false,
    code: "memory_unconfigured",
    structured: false,
  });
  // Not an empty answer: a deployment with no memory must not look like a
  // researcher who has never told the product anything.
  await assert.rejects(
    () => store.create("alpha", "content"),
    (error) => error?.status === 503 && error?.code === "memory_unconfigured",
  );
});

// The feedback ledger is durable, account-scoped state, so it lives in the
// shared product store and a deployment without one has no ledger. What must
// not happen is the route disappearing: a 404 tells a client the feature does
// not exist, and this feature does exist — it is the store that is missing.
test("the feedback routes are reachable and name the dependency they need", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "evimed-feedback-routes-"));
  const memory = researchMemoryDouble({
    id: "record_1", scope: "user", scopeId: "", kind: "preference", key: "response.evidence_depth",
    value: "优先给原始证据", summary: "原始证据优先", origin: "inferred", status: "pending",
    confidence: 0.7, importance: 0.9, sensitive: false, evidenceCount: 0, version: 1,
    evidence: [], revisions: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  });
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: true, researchMemory: memory,
  });
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal(app.feedbackEvents, null, "a file-backed control plane has no product ledger to append to");
    assert.equal(app.learningWorker, null, "and therefore nothing to distil from");

    for (const request of [
      { method: "GET", body: undefined },
      { method: "POST", body: JSON.stringify({ trigger: "deliverable-adopted", runId: "run_1", path: "reports/evidence.md" }) },
    ]) {
      const response = await fetch(`${base}/api/feedback/events`, {
        method: request.method, headers: { "Content-Type": "application/json" }, body: request.body,
      });
      const payload = await response.json();
      assert.equal(response.status, 503, `${request.method} /api/feedback/events answered ${response.status}`);
      assert.equal(payload.code, "feedback_unavailable");
    }

    // And the memory routes that write to it are unaffected by its absence: the
    // researcher's own action must never fail because a ledger is missing.
    const confirm = await fetch(`${base}/api/memory/records/record_1`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, status: "active" }),
    });
    assert.equal(confirm.status, 200);
    assert.equal((await confirm.json()).data.origin, "explicit");
    const removed = await fetch(`${base}/api/memory/records/record_1`, { method: "DELETE" });
    assert.equal(removed.status, 200);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
