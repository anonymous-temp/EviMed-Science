// The turn committer is composed into the app: a run that finishes in the real run ledger, on the mock runtime, arms the commit of
// its conversation for an attended turn of a native account, and arms nothing for a legacy account or a run the platform started.
// The committer's own rules are `nativeTurnCommit.test.mjs`; this holds the one line in `server.mjs` that calls it.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { nativeMemoryCounters, resetNativeMemoryMetrics } from "../src/nativeMemoryMetrics.mjs";
import { createWebApiApp } from "../src/server.mjs";

const SESSION = "ses_turn_commit";

/**
 * @param {{ engine: "native" | "legacy", automated?: boolean }} options
 * @returns {Promise<{ armed: boolean, asked: string[] }>}
 */
async function finishOneRun({ engine, automated = false }) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-turn-commit-"));
  /** @type {string[]} */
  const asked = [];
  const researchMemory = {
    configured: true,
    async status() { return { configured: true, connected: true, code: null, structured: true }; },
    async settings() { return { learningPaused: false, recallPaused: false, pausedProjects: [] }; },
    async memoryEngine(/** @type {string} */ userId) { asked.push(userId); return engine; },
    async relevant() { return []; },
    async residentRecords() { return []; },
    async lookupCounts() { return { user: 0, project: 0, session: 0 }; },
  };
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: true, runTitlesEnabled: false, memoryExtractionEnabled: false,
    researchMemory, ovNativeMemoryEnabled: true, nativeMemoryTurnCommitDebounceMs: 600_000,
    openVikingSessions: { configured: true, async readSession() { throw Object.assign(new Error("no session"), { code: "memory_index_not_found" }); } },
  });
  try {
    const address = await app.listen(0, "127.0.0.1");
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { "X-Open-Science-Project": "default", "Content-Type": "application/json" };
    let finished;
    const done = new Promise((resolve) => { finished = resolve; });
    const original = app.agentRuns.onRunFinished;
    app.agentRuns.onRunFinished = async (/** @type {any[]} */ ...args) => { try { return await original(...args); } finally { finished(); } };
    assert.equal((await fetch(`${base}/api/research-sessions/${SESSION}`, { method: "PUT", headers, body: JSON.stringify({ mode: "open-domain" }) })).status, 200);
    const dispatched = await fetch(`${base}/api/agent-runs/dispatch`, {
      method: "POST", headers, body: JSON.stringify({ sessionId: SESSION, dispatchId: `dispatch_${engine}_${automated}`, text: "我是心内科的主治医生。", ...(automated ? { automated: true } : {}) }),
    });
    assert.equal(dispatched.status, 202, await dispatched.clone().text());
    await done;
    // The hook arms the commit without waiting for it; its one settings read is a few turns of the event loop.
    for (const started = Date.now(); !app.nativeTurnCommit.armed.size && Date.now() - started < 1_000;) await new Promise((resolve) => setTimeout(resolve, 20));
    const armed = asked.some((userId) => app.nativeTurnCommit.isArmed(userId, SESSION));
    return { armed, asked };
  } finally {
    app.nativeTurnCommit.close();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("a finished attended run of a native account arms the commit of its conversation", async () => {
  const { armed, asked } = await finishOneRun({ engine: "native" });
  assert.ok(asked.length > 0, "the committer asked which engine the account is on");
  assert.equal(armed, true);
});

test("a legacy account's run arms nothing, and neither does a run the platform started", async () => {
  resetNativeMemoryMetrics();
  assert.equal((await finishOneRun({ engine: "legacy" })).armed, false);
  assert.equal(nativeMemoryCounters().turnCommits.platform_started, 0);
  const automated = await finishOneRun({ engine: "native", automated: true });
  assert.equal(automated.armed, false);
  assert.equal(nativeMemoryCounters().turnCommits.platform_started, 1, "turned away as a turn the platform started");
});
