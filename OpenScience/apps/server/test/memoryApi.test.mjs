// The memory routes on a deployment that has no database and no memory engine, and the things that must still be true there.
//
// The rest of these routes are exercised against the real store on PostgreSQL
// in `memoryApi.integration.test.mjs`. What is left here is what needs no
// database at all: what the status route says when there is no store, that a memory route
// says so by name when there is no engine, and that the feedback routes are reachable
// without the ledger they write to.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import { MemorySettingsStore } from "../src/memorySettings.mjs";

/** The store's surface, at the interface, with no database behind it: the switches a deployment without a ledger still answers. */
function settingsDouble() {
  return {
    configured: true,
    async status() { return { configured: true, connected: true, code: null }; },
    async settings() { return { learningPaused: false, recallPaused: false, pausedProjects: [], updatedAt: null }; },
  };
}

test("memory status reports an unconfigured store without pretending to be connected", async () => {
  const store = new MemorySettingsStore({}, { database: null });
  assert.equal(store.configured, false);
  assert.deepEqual(await store.status(), {
    configured: false,
    connected: false,
    code: "memory_unconfigured",
  });
  // Not an empty answer: a deployment with no memory must not look like a
  // researcher who has never told the product anything.
  await assert.rejects(
    () => store.updateSettings("alpha", { learningPaused: true }),
    (error) => error?.status === 503 && error?.code === "memory_unconfigured",
  );
});

// The feedback ledger is durable, account-scoped state, so it lives in the
// shared product store and a deployment without one has no ledger. What must
// not happen is the route disappearing: a 404 tells a client the feature does
// not exist, and this feature does exist — it is the store that is missing.
test("the feedback routes are reachable and name the dependency they need", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "evimed-feedback-routes-"));
  const memory = settingsDouble();
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: true, memorySettings: memory,
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

    // A memory route in a deployment with no engine says so by name, and not "feedback unavailable": the missing ledger is not what stopped it.
    const edit = await fetch(`${base}/api/memory/records/nm_0123456789abcdef01234567`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, value: "x" }),
    });
    assert.equal(edit.status, 503);
    assert.equal((await edit.json()).code, "memory_engine_unavailable");
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
