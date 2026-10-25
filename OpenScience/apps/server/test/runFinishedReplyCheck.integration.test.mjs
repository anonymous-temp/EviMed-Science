// 2026-10-10 OpenMed review E-16: the run-finished hook skipped the reply check for every conversation that had read a patient
// record, because the early return that keeps such a conversation out of memory and lessons sat above it. The check is a notice
// that never holds a reply back, and those are the answers that report counts from the record. It runs for them now; lessons still
// do not. (The same early return kept such a conversation out of the platform's own memory extraction too, until that engine was
// deleted on 2026-10-25; what the memory engine does with a clinical conversation is decided at its gateway.)
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createWebApiApp } from "../src/server.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const options = { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && "An isolated test PostgreSQL is required" };
const memoryStore = {
  configured: true,
  async status() { return { configured: true, connected: true, code: null, structured: true }; },
  async settings() { return { learningPaused: false, recallPaused: false, pausedProjects: [] }; },
};
const until = async (/** @type {() => boolean} */ condition, ms = 10_000) => {
  for (const started = Date.now(); !condition() && Date.now() - started < ms;) await new Promise((resolve) => setTimeout(resolve, 50));
  return condition();
};

/** One finished run in a mock runtime, with the privacy store answering `clinical`; what the reply check was asked. */
async function finishedRun(/** @type {boolean} */ clinical, /** @type {string} */ label) {
  const isolated = await createGeoTestDatabase(/** @type {string} */ (process.env.OPEN_SCIENCE_TEST_POSTGRES_URL), "replyclin");
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-reply-clinical-"));
  const vcrPrivacyStore = {
    async hasClinicalContext() { return clinical; },
    async clinicalContextsHeld(/** @type {string} */ _userId, /** @type {string} */ _projectId, /** @type {unknown[]} */ contexts) { return contexts.map(() => clinical); },
  };
  const app = createWebApiApp({ dataDir, stateStore: "postgres", databaseUrl: isolated.url, databasePoolMax: 4, port: 0, runtimeMode: "mock", devAuth: true,
    runTitlesEnabled: false, memorySettings: memoryStore, reviewEnabled: true, learningEnabled: false, frontierEnabled: false,
    geoEnabled: false, vcrEnabled: false, vcrPrivacyStore });
  try {
    const address = await app.listen(0, "127.0.0.1");
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { "X-Open-Science-Project": "default", "Content-Type": "application/json" };
    /** @type {any[]} */ const checked = [];
    app.reviewService.considerReply = async (/** @type {any[]} */ ...args) => { checked.push(args); return null; };
    assert.equal((await fetch(`${base}/api/research-sessions/ses_${label}`, { method: "PUT", headers, body: JSON.stringify({ mode: "open-domain" }) })).status, 200);
    const dispatched = await fetch(`${base}/api/agent-runs/dispatch`, { method: "POST", headers, body: JSON.stringify({ sessionId: `ses_${label}`, dispatchId: `dispatch_${label}`, text: "这位患者的肌酐是多少？" }) });
    assert.equal(dispatched.status, 202, await dispatched.clone().text());
    const runId = (await dispatched.json()).data.id;
    await until(() => checked.length > 0, 6_000);
    // Awaited a while after the run: give a step that would have run time to show it did not.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    return { checked, runId };
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
    await isolated.drop();
  }
}

test("the reply check runs for a conversation that read a patient record", options, async () => {
  const { checked, runId } = await finishedRun(true, "clinical");
  assert.equal(checked.length, 1, "the reply of a clinical conversation is checked");
  assert.equal(checked[0][1].id, runId, "as the run's own reply");
  assert.match(checked[0][2].replyText, /mock-agent-artifact/);
});

test("the control: an ordinary conversation is checked as before", options, async () => {
  const { checked, runId } = await finishedRun(false, "ordinary");
  assert.equal(checked.length, 1);
  assert.equal(checked[0][1].id, runId);
});
