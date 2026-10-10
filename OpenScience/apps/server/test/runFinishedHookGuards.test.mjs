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
