// A run that was stopped: how it ends, and what it hands over.
//
// Two defects from the public-benchmark baseline (2026-10-28/29):
//
// 1. BixBench bix-6. A python tool process reached 1.7 GB, the memory cgroup killed it and the kernel's node process with it
//    at minute 12, and the run was recorded `succeeded/degraded` with a progress sentence from minute 2 as its answer,
//    because it had written one file under `deliverables/` and a runtime that is gone with files on disk was a delivery.
//    A runtime that dies inside a turn is `failed / runtime_stopped`, with the files kept; a turn the kernel had ended
//    before the runtime went is still the delivery it always was.
// 2. DeepResearch Bench task 65. Cancelled at its cap with the report and the Word file built from it on disk, and
//    `presentedFiles` empty. A run that is stopped hands over its main document, chosen by a closed rule
//    (terminalPresentation.mjs), and its status stays what it was.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRunStore } from "../src/agentRuns.mjs";
import { noticeTexts } from "./helpers/noticeTexts.mjs";

const wait = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));
const turnStart = { type: "turn/start", turn: 1 };
const toolCall = { type: "tool/call", callId: "c1", tool: "bash", input: { command: "python analysis.py" }, narration: "" };
const answer = { type: "message/assistant", text: "分析做完了。", reasoning: "", usage: null, interrupted: false };
const progressSentence = { ...answer, text: "我先看一下数据。" };
const turnEnd = (/** @type {string} */ endKind) => ({ type: "turn/end", turn: 1, endKind });
/** A capability that owes files, so a run bound to it is not an ordinary conversation and only `deliverables/` is read. */
const owing = { id: "statistical-analysis", version: "1.4.1", runtimeAgent: "evimed-statistical-analysis", skill: "statistical-analysis", companionSkills: [],
  outputs: [{ path: "report.md", required: false }], completionChecks: [] };

/** @param {Record<string, any>} [options] */
async function fixture(options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "os-stopped-runs-"));
  const project = { id: "project-1", userId: "user-1", rootDir: root, workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, ".openscience") };
  await mkdir(project.workspaceDir, { recursive: true });
  await mkdir(project.metaDir, { recursive: true });
  const binding = { sessionId: "ses_stopped", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
  const makeStore = () => {
    const store = new AgentRunStore({ get: async () => binding }, {
      model: "deepseek/deepseek-v4-flash", readSessionHistory: async () => [], monitorIntervalMs: 60_000,
      agentRegistry: { get: (/** @type {string} */ id) => (id === owing.id ? owing : undefined) }, ...options,
    });
    store.scheduleMonitor = () => {};
    return store;
  };
  const store = makeStore();
  /** One run, the events the pump carried for it, the files it wrote, and how it ended. */
  const run = async (/** @type {{ events?: any[], files?: Record<string, string>, bound?: boolean, end: (store: AgentRunStore, run: any) => Promise<any> }} */ { events = [], files = {}, bound = false, end }) => {
    // Each run has the workspace to itself: a file an earlier run left within the freshness slack would be this one's.
    await rm(project.workspaceDir, { recursive: true, force: true });
    await mkdir(project.workspaceDir, { recursive: true });
    const started = await store.dispatch(project, {
      sessionId: binding.sessionId, dispatchId: `d_${Math.random().toString(16).slice(2, 10)}`,
      ...(bound ? { effectiveAgentId: owing.id, effectiveAgentVersion: owing.version, effectiveRuntimeAgent: owing.runtimeAgent } : {}),
    }, async () => ({ accepted: true }));
    await wait(25);
    let seq = 1;
    for (const event of events) store.noteRunEvent(project, started.id, { sessionId: binding.sessionId, child: false, replay: false, event: { seq: (seq += 1), ...event } });
    for (const [name, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(project.workspaceDir, name)), { recursive: true });
      await writeFile(path.join(project.workspaceDir, name), text);
    }
    await end(store, started);
    return (await store.list(project)).find((item) => item.id === started.id);
  };
  return { project, binding, store, makeStore, run, close: async () => { await store.closeAll(); await rm(root, { recursive: true, force: true }); } };
}
const bixFiles = { "deliverables/crispr-screen-analysis/analysis.py": "import pandas\nprint(1)\n" };

test("bix-6: a runtime that dies inside a turn is a stopped runtime with its files kept, never a success", async () => {
  const f = await fixture();
  try {
    const gone = (/** @type {AgentRunStore} */ store) => store.closeProject(f.project, "failed");
    const killed = await f.run({ events: [turnStart, progressSentence, toolCall], files: bixFiles, bound: true, end: gone });
    assert.equal(killed?.status, "failed", JSON.stringify(killed?.qualityNotices));
    assert.equal(killed?.errorCode, "runtime_stopped");
    assert.deepEqual(killed?.artifacts, [], "nothing was graded, and nothing is called accepted");
    assert.deepEqual(killed?.unverifiedArtifacts, ["deliverables/crispr-screen-analysis/analysis.py"], "what it had written stays, as the unchecked file it is");
    assert.ok(noticeTexts(killed).some((line) => line.includes("未经核验")), "and says so, the way every stopped run's files are labelled");
    assert.notEqual(killed?.verification, "unverified", "no success is marked unverified: there is none");

    // A turn that ended and then a later one began (a dispatched run's own `turn/start` is not forwarded, so the tool
    // call is what reopens the record) is a turn open.
    const reopened = await f.run({ events: [answer, turnEnd("completed"), toolCall], files: bixFiles, bound: true, end: gone });
    assert.deepEqual([reopened?.status, reopened?.errorCode], ["failed", "runtime_stopped"]);

    // An ordinary conversation keeps what it changed as its outputs, as a cancel does.
    const ordinary = await f.run({ events: [turnStart, toolCall], files: { "analysis/summary.xlsx": "not read" }, end: gone });
    assert.deepEqual([ordinary?.status, ordinary?.errorCode], ["failed", "runtime_stopped"]);
    assert.deepEqual(ordinary?.unverifiedArtifacts, ["analysis/summary.xlsx"]);
    assert.deepEqual(ordinary?.outputFiles, ["analysis/summary.xlsx"]);
  } finally { await f.close(); }
});

test("a turn the kernel had ended before the runtime went stays the delivery it was, and what the stream never spoke of is not guessed", async () => {
  const f = await fixture();
  try {
    const gone = (/** @type {AgentRunStore} */ store) => store.closeProject(f.project, "failed");
    // Ended `completed`, with its answer: the files are delivered, unverified, as before.
    const ended = await f.run({ events: [turnStart, toolCall, answer, turnEnd("completed")], files: bixFiles, bound: true, end: gone });
    assert.equal(ended?.status, "succeeded", JSON.stringify(ended?.qualityNotices));
    assert.equal(ended?.verification, "unverified");
    assert.deepEqual(ended?.artifacts, ["deliverables/crispr-screen-analysis/analysis.py"]);
    assert.ok(noticeTexts(ended).some((line) => line.includes("运行时在核验之前已经停止")));

    // The end event without a closing message is still an end: the record is the kernel's `turn/end`, not the text.
    const silent = await f.run({ events: [turnStart, toolCall, turnEnd("completed")], files: bixFiles, bound: true, end: gone });
    assert.equal(silent?.status, "succeeded", "an ended turn is not read as open because its last message was a tool call");

    // Nothing on the record at all (a control plane restarted since, whose replayed events say nothing of how a turn ends):
    // not known, so the files are a delivery as they were.
    const unknown = await f.run({ events: [], files: bixFiles, bound: true, end: gone });
    assert.equal(unknown?.status, "succeeded");
    assert.equal(unknown?.verification, "unverified");

    // A turn the kernel ended in some other way is an ended turn; this path does not reinterpret how it ended.
    const aborted = await f.run({ events: [turnStart, toolCall, turnEnd("aborted")], files: bixFiles, bound: true, end: gone });
    assert.equal(aborted?.status, "succeeded");

    // The same facts with the turn open and no files: as it always was.
    const bare = await f.run({ events: [turnStart, toolCall], files: {}, bound: true, end: gone });
    assert.deepEqual([bare?.status, bare?.errorCode, bare?.unverifiedArtifacts], ["failed", "runtime_stopped", []]);
  } finally { await f.close(); }
});

test("a runtime the user stopped inside a turn is the user's stop, and keeps the files too", async () => {
  const f = await fixture();
  try {
    const stopped = await f.run({
      events: [turnStart, toolCall], files: bixFiles, bound: true,
      end: async (store) => {
        await store.noteRuntimeStop(f.project, { by: "user" });
        await store.closeProject(f.project, "failed");
      },
    });
    assert.deepEqual([stopped?.status, stopped?.errorCode, stopped?.canceledBy], ["canceled", "runtime_canceled", "user"]);
    assert.deepEqual(stopped?.unverifiedArtifacts, ["deliverables/crispr-screen-analysis/analysis.py"]);
  } finally { await f.close(); }
});

test("DeepResearch Bench 65: a run cancelled with its report on disk presents the report and its Word file, and stays cancelled", async () => {
  const f = await fixture();
  try {
    const files = {
      "grain-3d-control/report/report.md": "# 报告\n".repeat(400),
      "grain-3d-control/report/Grain_Design_Report.docx": "docx bytes ".repeat(500),
      "grain-3d-control/report/parts/p1.md": "# 一\n".repeat(900),
      "grain-3d-control/report/build.py": "print('build')\n",
      "grain-3d-control/figures/fig01.png": "png bytes",
      "grain-3d-control/results/results.json": "{}",
      "tmp/scratch.md": "# scratch\n".repeat(900),
    };
    const cancelByUser = (/** @type {AgentRunStore} */ store, /** @type {any} */ started) =>
      store.finishInternal(f.project, started.id, { status: "canceled", errorCode: "runtime_canceled", artifacts: [], canceledBy: "user" });
    const capped = await f.run({ events: [turnStart, progressSentence], files, end: cancelByUser });
    assert.deepEqual([capped?.status, capped?.errorCode, capped?.canceledBy], ["canceled", "runtime_canceled", "user"], "the status does not change");
    assert.deepEqual(capped?.presentedFiles, ["grain-3d-control/report/Grain_Design_Report.docx", "grain-3d-control/report/report.md"].sort());
    assert.ok(capped?.unverifiedArtifacts.includes("grain-3d-control/report/parts/p1.md"), "the pieces are still the run's files");
    assert.ok(capped?.outputFiles.includes("grain-3d-control/figures/fig01.png"));
    assert.deepEqual(capped?.artifacts, []);
    // Kept in the ledger: a store that reads the file afresh sees the same record.
    const reread = (await f.makeStore().list(f.project)).find((item) => item.id === capped.id);
    assert.deepEqual(reread?.presentedFiles, capped?.presentedFiles);
    assert.equal(reread?.status, "canceled");

    // Whoever stops it: the platform shutting the runtime is the same.
    const byPlatform = await f.run({ events: [turnStart, progressSentence], files, end: (store) => store.closeProject(f.project, "canceled") });
    assert.deepEqual([byPlatform?.status, byPlatform?.canceledBy], ["canceled", "platform"]);
    assert.deepEqual(byPlatform?.presentedFiles, capped?.presentedFiles);

    // And a runtime that died under it.
    const died = await f.run({ events: [turnStart, toolCall], files, end: (store) => store.closeProject(f.project, "failed") });
    assert.deepEqual([died?.status, died?.errorCode], ["failed", "runtime_stopped"]);
    assert.deepEqual(died?.presentedFiles, capped?.presentedFiles);
  } finally { await f.close(); }
});

test("a stopped run with no document hands over nothing, and a run that was not stopped is left alone", async () => {
  const f = await fixture();
  try {
    const cancel = (/** @type {AgentRunStore} */ store, /** @type {any} */ started) =>
      store.finishInternal(f.project, started.id, { status: "canceled", errorCode: "runtime_canceled", artifacts: [], canceledBy: "user" });
    // Cancelled before it wrote anything.
    const nothing = await f.run({ events: [turnStart], files: {}, end: cancel });
    assert.equal(nothing?.status, "canceled");
    assert.equal(nothing?.presentedFiles, undefined);
    assert.deepEqual(nothing?.unverifiedArtifacts, []);
    // Scripts, figures, data and the pieces of a document are files, not the document.
    const scraps = await f.run({
      events: [turnStart], end: cancel,
      files: { "a/model.py": "x = 1\n", "a/fig.png": "png", "a/out.json": "{}", "a/parts/p1.md": "# piece\n".repeat(50), "a/notes.txt": "plain" },
    });
    assert.equal(scraps?.status, "canceled");
    assert.equal(scraps?.presentedFiles, undefined);
    assert.equal(scraps?.unverifiedArtifacts.length, 5, "they are all still kept");
    // A caller that already named what was presented is not second-guessed.
    const named = await f.run({
      events: [turnStart], files: { "a/report.md": "# r\n".repeat(50) },
      end: (store, started) => store.finishInternal(f.project, started.id, { status: "canceled", errorCode: "runtime_canceled", artifacts: [], presentedFiles: ["a/chosen.docx"] }),
    });
    assert.deepEqual(named?.presentedFiles, ["a/chosen.docx"]);
    // A run that failed for any other reason presents nothing it did not present itself.
    const refused = await f.run({
      events: [turnStart], files: { "a/report.md": "# r\n".repeat(50) },
      end: (store, started) => store.finishInternal(f.project, started.id, { status: "failed", errorCode: "runtime_session_error", artifacts: [] }),
    });
    assert.equal(refused?.status, "failed");
    assert.equal(refused?.presentedFiles, undefined);
    // And one that succeeded presents what it presented, never a choice made for it.
    const done = await f.run({
      events: [turnStart, answer, turnEnd("completed")], files: { "a/report.md": "# r\n".repeat(50) },
      end: (store, started) => store.finishInternal(f.project, started.id, { status: "succeeded", errorCode: null, artifacts: ["a/report.md"] }),
    });
    assert.equal(done?.status, "succeeded");
    assert.equal(done?.presentedFiles, undefined);
  } finally { await f.close(); }
});
