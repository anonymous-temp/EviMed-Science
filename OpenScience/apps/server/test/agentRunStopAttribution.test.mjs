// Who stopped a run, told to the ledger before the stop reaches the kernel (review F2, F4, F6).
//
// A run a user stopped is charged for what ran; a run the platform stopped is not; a stop nobody can
// attribute is not either. The kernel's own abort ends a turn with an error the monitor reads, and the
// monitor can win the race against the control plane's own write — so the intent is recorded first, and
// `finishInternal` applies it to any `canceled` terminal of that run.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRunStore } from "../src/agentRuns.mjs";

/** @param {Record<string, any>} [options] */
async function fixture(options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "os-stop-attribution-"));
  const project = { id: "stop-project", userId: "researcher", rootDir: root, workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, ".openscience") };
  const binding = { sessionId: "ses_stop", mode: "specialist", agentId: "adr-analysis", agentVersion: "1.0.0", runtimeAgent: "evimed-adr-analysis" };
  await mkdir(project.workspaceDir, { recursive: true });
  await mkdir(project.metaDir, { recursive: true });
  const clock = { at: new Date("2026-10-05T03:00:00.000Z") };
  const store = new AgentRunStore({ get: async () => binding }, { model: "deepseek/deepseek-v4-flash", readSessionHistory: async () => [], monitorIntervalMs: 60_000, now: () => new Date(clock.at), ...options });
  const route = { sessionId: binding.sessionId, effectiveAgentId: binding.agentId, effectiveAgentVersion: binding.agentVersion, effectiveRuntimeAgent: binding.runtimeAgent };
  let turn = 0;
  const start = async () => store.dispatch(project, { ...route, dispatchId: `turn-${++turn}` }, async () => ({ accepted: true }));
  return { project, binding, store, clock, start, close: async () => { await store.closeProject(project); await rm(root, { recursive: true, force: true }); } };
}
/** What the monitor writes when it sees a turn end in an abort: a cancel with nobody named. */
const monitorCancel = { status: "canceled", errorCode: "runtime_canceled", artifacts: [] };
const finished = async (/** @type {any} */ f, /** @type {string} */ id) => (await f.store.list(f.project)).find((run) => run.id === id);

test("a cancel nobody is named for is unattributed, and a stop noted before the kernel call makes the monitor's own cancel the user's", async () => {
  const f = await fixture();
  try {
    const bare = await f.start();
    await f.store.finishInternal(f.project, bare.id, monitorCancel);
    assert.equal((await finished(f, bare.id)).canceledBy, undefined, "no stop was asked for, so none is attributed");

    const asked = await f.start();
    assert.equal(await f.store.noteStopRequest(f.project, { sessionId: f.binding.sessionId }), asked.id, "found by the session the kernel's stop names");
    // The monitor wins the race to the terminal write: the user's intent was recorded first.
    await f.store.finishInternal(f.project, asked.id, monitorCancel);
    const run = await finished(f, asked.id);
    assert.deepEqual([run.status, run.canceledBy], ["canceled", "user"]);
  } finally { await f.close(); }
});

test("by run id as the runs page stops it, and what the platform wrote stays the platform's", async () => {
  const f = await fixture();
  try {
    const a = await f.start();
    assert.equal(await f.store.noteStopRequest(f.project, { runId: a.id }), a.id);
    await f.store.finishInternal(f.project, a.id, monitorCancel);
    assert.equal((await finished(f, a.id)).canceledBy, "user");
    // A platform stop that names itself is not turned into the user's by a stop that was asked for earlier.
    const b = await f.start();
    await f.store.noteStopRequest(f.project, { runId: b.id });
    await f.store.finishInternal(f.project, b.id, { ...monitorCancel, canceledBy: "platform" });
    assert.equal((await finished(f, b.id)).canceledBy, "platform");
  } finally { await f.close(); }
});

test("a stop that did not end the run is forgotten: it never turns a later platform cancel, or a delivered run, into a user's", async () => {
  const f = await fixture();
  try {
    const delivered = await f.start();
    await f.store.noteStopRequest(f.project, { runId: delivered.id });
    await f.store.finishInternal(f.project, delivered.id, { status: "succeeded", artifacts: [] });
    assert.equal((await finished(f, delivered.id)).status, "succeeded");
    assert.equal((await finished(f, delivered.id)).canceledBy, undefined);
    // Asked for, the run went on; minutes later a release cancelled it. That is not the user's stop.
    const later = await f.start();
    await f.store.noteStopRequest(f.project, { runId: later.id });
    f.clock.at = new Date(f.clock.at.getTime() + 10 * 60_000);
    await f.store.finishInternal(f.project, later.id, monitorCancel);
    assert.equal((await finished(f, later.id)).canceledBy, undefined, "past the window it is unattributed, and unattributed is not charged");
  } finally { await f.close(); }
});

test("a stop for nothing that is running, or for a run of another project, notes nothing", async () => {
  const f = await fixture();
  try {
    assert.equal(await f.store.noteStopRequest(f.project, { sessionId: "ses_nobody" }), null);
    assert.equal(await f.store.noteStopRequest(f.project, { runId: "run_unknown" }), null);
    const run = await f.start();
    await f.store.finishInternal(f.project, run.id, { status: "failed", errorCode: "runtime_session_error", artifacts: [] });
    assert.equal(await f.store.noteStopRequest(f.project, { runId: run.id }), null, "a run that is over has nothing to stop");
    for (const bad of [{}, { runId: 5 }, { sessionId: "" }]) assert.equal(await f.store.noteStopRequest(f.project, /** @type {any} */ (bad)), null);
  } finally { await f.close(); }
});

test("closeProject names who asked: the user's own runtime stop is theirs, and the default, a release or an idle reap, is the platform's", async () => {
  const f = await fixture();
  try {
    const mine = await f.start();
    await f.store.closeProject(f.project, "canceled", "runtime_canceled", { by: "user" });
    assert.equal((await finished(f, mine.id)).canceledBy, "user");
    const theirs = await f.start();
    await f.store.closeProject(f.project, "canceled", "runtime_canceled");
    assert.equal((await finished(f, theirs.id)).canceledBy, "platform", "when nobody says, the platform: it cannot overcharge");
    const odd = await f.start();
    await f.store.closeProject(f.project, "canceled", "runtime_canceled", { by: /** @type {any} */ ("someone") });
    assert.equal((await finished(f, odd.id)).canceledBy, "platform");
    const failed = await f.start();
    await f.store.closeProject(f.project, "failed", "runtime_stopped", { by: "user" });
    assert.equal((await finished(f, failed.id)).canceledBy, undefined, "a run that failed was not stopped by anyone");
  } finally { await f.close(); }
});
