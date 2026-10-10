// 2026-10-10 review M-15 (gate G4): the run-finished hook collects the run's conversation while its container is alive
// (the transcript branch: a pre-stop snapshot, or a fresh read) and writes it down. The memory branch, a few steps later,
// read the conversation again from the live runtime; a runtime that had been stopped, evicted or had crashed answered
// `runtime_not_running`, the messages were [] and there was no run summary and no extraction, with only a line of audit
// ("history=runtime_not_running") to say why. The branch now reads what the hook has already collected, and goes back to
// the live runtime only when the hook collected nothing for the run's own session.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { HttpError } from "../src/security.mjs";
import { normalizeTranscript, transcriptToLedgerMessages } from "../src/dshRuntimeAdapter.mjs";
import { createWebApiApp } from "../src/server.mjs";

const SESSION = "ses_collected";
const REQUEST = "请评估利伐沙班在老年房颤患者中的出血风险。";
const memoryStore = {
  configured: true,
  async status() { return { configured: true, connected: true, code: null, structured: true }; },
  async settings() { return { learningPaused: false, recallPaused: false, pausedProjects: [] }; },
  async relevant() { return []; },
  // What a dispatch reads of the researcher's memory since review M6: the standing profile and the counts beside it.
  async residentRecords() { return []; },
  async lookupCounts() { return { user: 0, project: 0, session: 0 }; },
};

/** A finished one-turn conversation, as the kernel's event log normalizes. */
function conversation() {
  const at = Date.now();
  return normalizeTranscript(SESSION, [
    { event: { type: "turn/start", seq: 1, time: at, data: { turn: 1 } } },
    { event: { type: "user/message", seq: 2, time: at + 1, data: { turn: 1, step: 1, source: { kind: "user" }, content: [{ type: "text", text: REQUEST }] } } },
    { event: { type: "assistant/message", seq: 3, time: at + 2, data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "出血风险随年龄升高，建议按肌酐清除率调整剂量。" }] } } } },
    { event: { type: "turn/end", seq: 4, time: at + 3, data: { turn: 1, reason: { kind: "completed" } } } },
  ]);
}

const until = async (/** @type {() => boolean} */ condition, ms = 10_000) => {
  for (const started = Date.now(); !condition() && Date.now() - started < ms;) await new Promise((resolve) => setTimeout(resolve, 50));
  return condition();
};

/**
 * The real app on the mock runtime, a run dispatched into it, and what `memoryIntelligence.recordRun` was handed.
 * `readConversation(phase)` is what the runtime answers a read of the conversation: `phase` is "alive" until the hook has
 * written the transcript down, "gone" after — the container going away right behind the capture, which is the race.
 * @param {(phase: "alive" | "gone") => Promise<any>} readConversation
 * @param {{ liveMessages?: (() => Promise<any[]>) | null }} [options] replaces the live message read of the memory branch
 */
async function runWith(readConversation, { liveMessages = null } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-memory-transcript-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: true, runTitlesEnabled: false, memoryExtractionEnabled: false, researchMemory: memoryStore });
  try {
    const address = await app.listen(0, "127.0.0.1");
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { "X-Open-Science-Project": "default", "Content-Type": "application/json" };
    let hookStarted = false;
    let captured = false;
    // Until the run-finished hook starts, the run lives as the mock runtime has it; from then on, what the runtime says about
    // the conversation is what the test says.
    const original = app.runtimeManager.sessionTranscript.bind(app.runtimeManager);
    app.runtimeManager.sessionTranscript = async (/** @type {any[]} */ ...args) => (hookStarted ? readConversation(captured ? "gone" : "alive") : original(...args));
    if (liveMessages) {
      const live = app.runtimeManager.sessionMessages.bind(app.runtimeManager);
      app.runtimeManager.sessionMessages = async (/** @type {any[]} */ ...args) => (hookStarted ? liveMessages() : live(...args));
    }
    const finished = app.agentRuns.onRunFinished;
    app.agentRuns.onRunFinished = async (/** @type {any[]} */ ...args) => { hookStarted = true; return finished(...args); };
    const recordLearning = app.agentRuns.recordLearning.bind(app.agentRuns);
    // The transcript receipt is recorded the moment the capture is written: the container goes away right behind it.
    app.agentRuns.recordLearning = async (/** @type {any[]} */ ...args) => {
      const result = await recordLearning(...args);
      if (args[2]?.transcript) captured = true;
      return result;
    };
    /** @type {any[][]} */
    const handed = [];
    const recordRun = app.memoryIntelligence.recordRun.bind(app.memoryIntelligence);
    app.memoryIntelligence.recordRun = async (/** @type {any[]} */ ...args) => { handed.push(args[2]); return recordRun(...args); };

    assert.equal((await fetch(`${base}/api/research-sessions/${SESSION}`, { method: "PUT", headers, body: JSON.stringify({ mode: "open-domain" }) })).status, 200);
    const dispatched = await fetch(`${base}/api/agent-runs/dispatch`, { method: "POST", headers, body: JSON.stringify({ sessionId: SESSION, dispatchId: "dispatch_collected", text: REQUEST }) });
    assert.equal(dispatched.status, 202, await dispatched.clone().text());
    assert.equal(await until(() => handed.length > 0), true, "the memory branch was never reached");
    // The hook writes its audit line after `recordRun` returns, and does not wait for it.
    const readAudit = async () => (await readFile(path.join(dataDir, ".openscience", "security.jsonl"), "utf8").catch(() => ""))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
    let audit = await readAudit();
    for (const started = Date.now(); !audit.some((row) => row.action === "memory.agent_run.record") && Date.now() - started < 10_000;) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      audit = await readAudit();
    }
    return { handed, captured, audit };
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

const gone = () => new HttpError(409, "runtime_not_running", "The runtime is not running.");

test("a runtime that is gone by the time memory is written does not cost the run its extraction", async () => {
  const { handed, captured } = await runWith(async (phase) => {
    if (phase === "gone") throw gone();
    return conversation();
  });
  assert.equal(captured, true, "the transcript was written down first, which is what makes this the race it is");
  assert.equal(handed.length, 1);
  const texts = handed[0].flatMap((message) => (message.parts ?? []).map((part) => part.text));
  assert.ok(texts.includes(REQUEST), `the extractor was handed ${handed[0].length} messages; the researcher's request is in the conversation that was collected`);
  assert.deepEqual(handed[0].map((message) => message.info.role), ["user", "assistant"]);
});

test("what memory reads is the conversation the hook collected, not a second read of the runtime", async () => {
  /** @type {string[]} */
  const phases = [];
  const { handed } = await runWith(async (phase) => { phases.push(phase); return conversation(); },
    { liveMessages: async () => { throw new Error("the live runtime must not be asked when the hook already holds the conversation"); } });
  assert.equal(handed[0].length, 2);
  assert.deepEqual([...new Set(phases)], ["alive"], "one read, while the container was alive");
});

test("when the hook could not collect the run's own session, memory still asks the live runtime, as it did", async () => {
  const live = transcriptToLedgerMessages(conversation());
  const { handed, audit } = await runWith(async () => { throw gone(); }, { liveMessages: async () => live });
  assert.equal(handed[0].length, 2, "the fallback is the live read");
  assert.equal(audit.some((row) => row.action === "memory.agent_run.record" && /history=/.test(String(row.detail))), false, "and it worked, so no gap is reported");

  // Neither source answers: nothing to extract from, and the audit line says why, as before.
  const none = await runWith(async () => { throw gone(); }, { liveMessages: async () => { throw gone(); } });
  assert.deepEqual(none.handed[0], []);
  assert.ok(none.audit.some((row) => row.action === "memory.agent_run.record" && /history=runtime_not_running/.test(String(row.detail))));
});
