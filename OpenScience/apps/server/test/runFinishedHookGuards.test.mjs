// 2026-10-10 review M-17: the run-finished hook awaits about twenty steps before it writes the transcript down, extracts
// memory and queues the lessons, and only some of them guarded themselves. A throw in any other one went to
// `onRunFinishedError`, which writes one audit line: the run's transcript, memory and lessons were skipped, silently.
// Each step now costs only itself, is audited under its own name, and the credit settlement stays in the `finally`.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createWebApiApp } from "../src/server.mjs";

const memoryStore = {
  configured: true,
  async status() { return { configured: true, connected: true, code: null, structured: true }; },
  async settings() { return { learningPaused: false, recallPaused: false, pausedProjects: [] }; },
  async relevant() { return []; },
  // What a dispatch reads of the researcher's memory since review M6: the standing profile and the counts beside it.
  async residentRecords() { return []; },
  async lookupCounts() { return { user: 0, project: 0, session: 0 }; },
};

const until = async (/** @type {() => boolean} */ condition, ms = 8_000) => {
  for (const started = Date.now(); !condition() && Date.now() - started < ms;) await new Promise((resolve) => setTimeout(resolve, 50));
  return condition();
};

async function auditRows(/** @type {string} */ dataDir) {
  const text = await readFile(path.join(dataDir, ".openscience", "security.jsonl"), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("a step of the run-finished hook that throws costs that step, and memory extraction still runs", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-run-finished-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: true, runTitlesEnabled: false, memoryExtractionEnabled: false, researchMemory: memoryStore });
  try {
    const address = await app.listen(0, "127.0.0.1");
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { "X-Open-Science-Project": "default", "Content-Type": "application/json" };

    /** @type {string[]} */
    const extracted = [];
    const recordRun = app.memoryIntelligence.recordRun.bind(app.memoryIntelligence);
    app.memoryIntelligence.recordRun = async (/** @type {any[]} */ ...args) => { extracted.push(args[1].id); return recordRun(...args); };
    // The step before the transcript, the memory and the lessons that publishes the run's state to its stream.
    app.runtimeEventPump.noteRun = () => { throw Object.assign(new Error("the event pump is down"), { code: "pump_down" }); };

    assert.equal((await fetch(`${base}/api/research-sessions/ses_hook`, { method: "PUT", headers, body: JSON.stringify({ mode: "open-domain" }) })).status, 200);
    const dispatched = await fetch(`${base}/api/agent-runs/dispatch`, { method: "POST", headers, body: JSON.stringify({ sessionId: "ses_hook", dispatchId: "dispatch_hook", text: "抗凝药物的出血风险怎么评估？" }) });
    assert.equal(dispatched.status, 202, await dispatched.clone().text());

    assert.equal(await until(() => extracted.length > 0), true, "memory extraction was skipped by a step that came before it");
    const failures = (await auditRows(dataDir)).filter((row) => row.action === "run.completion.step" && row.status === "failed");
    assert.deepEqual(failures.map((row) => [row.code, String(row.detail).split(":")[0]]), [["pump_down", "run.events"]],
      "the step is named, and nothing else failed");
    assert.equal((await auditRows(dataDir)).some((row) => row.action === "memory.agent_run.record" && row.status === "failed"), false,
      "it no longer reaches the catch-all that reports a memory failure");
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

// 2026-10-10 review D7: the question "may this run's work be copied into memory, methods and the evaluation corpus" is the VCR
// store's, asked first in the hook, and a store that could not answer used to read as "no" through a bare `.catch(() => false)`.
// "No" is the right default for a privacy boundary and stays; what was wrong is that nothing said so: the run's evolution
// outcome, handbook observations, graph evidence and memory extraction were skipped with no audit line and no number.
test("a clinical-privacy check that cannot answer is audited under its step and counted, the run still completes, and nothing is copied from it", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-run-finished-privacy-"));
  const asked = [];
  const vcrPrivacyStore = {
    async hasClinicalContext() { asked.push("one"); throw Object.assign(new Error("the privacy store is down"), { code: "privacy_store_down" }); },
    async clinicalContextsHeld() { asked.push("many"); throw Object.assign(new Error("the privacy store is down"), { code: "privacy_store_down" }); },
  };
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: true, runTitlesEnabled: false, memoryExtractionEnabled: false,
    researchMemory: memoryStore, operatorMetricsToken: "test-only-metrics-token", vcrPrivacyStore });
  try {
    const address = await app.listen(0, "127.0.0.1");
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { "X-Open-Science-Project": "default", "Content-Type": "application/json" };

    /** @type {string[]} */
    const extracted = [];
    const recordRun = app.memoryIntelligence.recordRun.bind(app.memoryIntelligence);
    app.memoryIntelligence.recordRun = async (/** @type {any[]} */ ...args) => { extracted.push(args[1].id); return recordRun(...args); };

    assert.equal((await fetch(`${base}/api/research-sessions/ses_privacy`, { method: "PUT", headers, body: JSON.stringify({ mode: "open-domain" }) })).status, 200);
    const dispatched = await fetch(`${base}/api/agent-runs/dispatch`, { method: "POST", headers, body: JSON.stringify({ sessionId: "ses_privacy", dispatchId: "dispatch_privacy", text: "抗凝药物的出血风险怎么评估？" }) });
    assert.equal(dispatched.status, 202, await dispatched.clone().text());
    const runId = (await dispatched.json()).data.id;

    const failure = async () => (await auditRows(dataDir)).find((row) => row.action === "run.completion.step" && row.status === "failed");
    let row = await failure();
    for (const started = Date.now(); !row && Date.now() - started < 8_000;) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      row = await failure();
    }
    assert.ok(row, "the failed check is audited");
    assert.equal(row.code, "privacy_store_down");
    assert.match(String(row.detail), /^clinical\.context: the privacy store is down/, "under the step's name, with the reason");
    assert.deepEqual((await auditRows(dataDir)).filter((entry) => entry.action === "run.completion.step").map((entry) => String(entry.detail).split(":")[0]), ["clinical.context"], "and no other step failed");

    // The run's own completion goes on: it reaches a terminal state and the counter says how often this happened.
    let status = "running";
    for (const started = Date.now(); status === "running" && Date.now() - started < 8_000;) {
      status = (await (await fetch(`${base}/api/agent-runs`, { headers })).json()).data.find((/** @type {any} */ item) => item.id === runId)?.status ?? "running";
      if (status === "running") await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.notEqual(status, "running", "the run finished");
    const metrics = await (await fetch(`${base}/api/ops/metrics`, { headers: { Authorization: "Bearer test-only-metrics-token" } })).text();
    assert.ok(metrics.split("\n").includes('evimed_run_completion_step_failures_total{step="clinical.context"} 1'), "counted under the step's name");
    // Fail closed, as before: a question that could not be answered is a "no".
    assert.deepEqual(extracted, [], "nothing is extracted into memory from a run whose privacy question failed");
    assert.deepEqual([...new Set(asked)], ["one"]);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
