// A 虚拟临床研究 step as a turn of the study's own conversation (R19 phase 2): the run ledger's side of it.
//
// The study's conversation is bound to the analyst (`vcr-protocol`) and a step's capability is another (`vcr-evidence`, `vcr-analysis`,
// …). Found live on a real kernel: the first prototype dispatched the step with its own capability into the bound conversation, the
// ledger wrote the row and then refused to fold it ("Specialist run effective identity does not match its session binding"), and from
// then on every read of that project's runs answered 500 `agent_runs_corrupt` — the whole project's conversation read 「正在重连」.
// What is held here: a turn the control plane routes over the binding is recorded under the identity it ran as, the ledger folds it
// and every read after it, a restart reads it back, the research-session record keeps its binding, and everything that is not such a
// turn still takes the binding's identity.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runRoleOf } from "@evimed/domain";
import { AgentRunStore } from "../src/agentRuns.mjs";
import { loadConfig } from "../src/config.mjs";
import { sessionInboxOf } from "../src/dshRuntimeAdapter.mjs";
import { HttpError } from "../src/security.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const BINDING = Object.freeze({ sessionId: "session-study", mode: "specialist", agentId: "vcr-protocol", agentVersion: "1.3.4", runtimeAgent: "evimed-vcr-protocol" });
const EVIDENCE = Object.freeze({ effectiveAgentId: "vcr-evidence", effectiveAgentVersion: "1.3.0", effectiveRuntimeAgent: "evimed-vcr-evidence" });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "os-vcr-turn-"));
  const project = { id: "vcr-turn", userId: "researcher", rootDir: root, workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, ".openscience") };
  await mkdir(project.workspaceDir, { recursive: true });
  await mkdir(project.metaDir, { recursive: true });
  const createStore = () => new AgentRunStore({ get: async () => BINDING }, { model: "deepseek/deepseek-v4-flash", readSessionHistory: async () => [], monitorIntervalMs: 60_000 });
  return { root, project, createStore };
}

test("a step dispatched over the conversation's binding is recorded as the capability it ran as, and the ledger reads back", async () => {
  const { root, project, createStore } = await fixture();
  const store = createStore();
  const restarted = createStore();
  try {
    const sent = [];
    const run = await store.dispatch(project, {
      sessionId: BINDING.sessionId, dispatchId: "vcr-evidence-1", automated: true, question: "找证据、整理假设卡", brief: "研究：…vcr_read…",
      ...EVIDENCE, effectiveRouteReason: "vcr:turn:evidence", routedOverBinding: true,
    }, async (session, dispatched) => { sent.push({ session, id: dispatched.id }); return { accepted: true }; });
    // The turn is the step's, in the conversation it was dispatched into.
    assert.equal(run.sessionId, BINDING.sessionId);
    assert.equal(run.effectiveAgentId, "vcr-evidence");
    assert.equal(run.effectiveRuntimeAgent, "evimed-vcr-evidence");
    assert.equal(run.effectiveRouteReason, "vcr:turn:evidence");
    assert.equal(runRoleOf(run), null, "a turn of the conversation, never one of the programme's hidden runs");
    // The sender is handed the research session as it is bound — what the run's context is prepared from.
    assert.equal(sent.length, 1);
    assert.equal(sent[0].session.agentId, "vcr-protocol");
    // The row folds with the identity it ran as: no read of the project's runs fails on it, now or after a restart.
    assert.equal((await store.list(project)).length, 1);
    const events = (await readFile(path.join(project.metaDir, "runs.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const started = events.find((event) => event.event === "started");
    assert.equal(started.agentId, started.effectiveAgentId, "the row's pin is the identity it ran as, so the fold accepts it");
    await store.cancelSession(project, BINDING.sessionId);
    await store.closeProject(project);
    const reread = (await restarted.list(project)).find((item) => item.id === run.id);
    assert.equal(reread.effectiveAgentId, "vcr-evidence");
    // The next dispatch into that conversation that is not such a turn takes the binding's identity, as every dispatch always did.
    const ordinary = await restarted.dispatch(project, {
      sessionId: BINDING.sessionId, dispatchId: "plain-1", question: "继续", ...EVIDENCE, effectiveRouteReason: "choice:vcr-evidence",
    }, async () => ({ accepted: true }));
    assert.equal(ordinary.effectiveAgentId, "vcr-protocol", "a binding still owns the identity of every turn nobody routed over it");
    assert.equal(ordinary.effectiveRuntimeAgent, "evimed-vcr-protocol");
    assert.equal((await restarted.list(project)).length, 2, "the ledger holds both and is readable");
  } finally {
    await store.closeProject(project);
    await restarted.closeProject(project);
    await rm(root, { recursive: true, force: true });
  }
});

test("a turn routed over the binding must name the capability it is a turn of, and says so as a boolean", async () => {
  const { root, project, createStore } = await fixture();
  const store = createStore();
  try {
    const refused = (input, pattern) => assert.rejects(store.dispatch(project, { sessionId: BINDING.sessionId, ...input }, async () => ({ accepted: true })),
      (error) => error instanceof HttpError && error.status === 400 && pattern.test(error.message), JSON.stringify(input));
    await refused({ dispatchId: "vcr-no-capability", routedOverBinding: true }, /specialist/i);
    await refused({ dispatchId: "vcr-not-boolean", routedOverBinding: "yes", ...EVIDENCE }, /boolean/i);
    // A refused dispatch leaves nothing in the ledger.
    assert.deepEqual(await store.list(project), []);
  } finally {
    await store.closeProject(project);
    await rm(root, { recursive: true, force: true });
  }
});

test("the lever is off unless it is switched on, and a deployment switches it on by its one name", () => {
  const saved = process.env.OPEN_SCIENCE_VCR_STEPS_IN_STUDY_SESSION;
  try {
    delete process.env.OPEN_SCIENCE_VCR_STEPS_IN_STUDY_SESSION;
    assert.equal(loadConfig({ rootDir: repoRoot }).vcrStepsInStudySession, false, "default off");
    process.env.OPEN_SCIENCE_VCR_STEPS_IN_STUDY_SESSION = "true";
    assert.equal(loadConfig({ rootDir: repoRoot }).vcrStepsInStudySession, true);
    process.env.OPEN_SCIENCE_VCR_STEPS_IN_STUDY_SESSION = "false";
    assert.equal(loadConfig({ rootDir: repoRoot }).vcrStepsInStudySession, false);
  } finally {
    if (saved === undefined) delete process.env.OPEN_SCIENCE_VCR_STEPS_IN_STUDY_SESSION;
    else process.env.OPEN_SCIENCE_VCR_STEPS_IN_STUDY_SESSION = saved;
  }
});

test("what waits in a session is read off its entry in the kernel's list, and silence is never read as nothing", () => {
  const entry = (/** @type {any} */ inbox, /** @type {boolean} */ running = false) => ({ sessionId: "s", running, projections: { kind: "sequenced", asOfSeq: 7, values: { title: null, inbox } } });
  // The shape the kernel answers (read off a live DSH 0.2.0-rc.2 kernel's `session/list`).
  assert.deepEqual(sessionInboxOf(entry({ "next-turn": [], "next-step": [] })), { running: false, queued: 0 });
  assert.deepEqual(sessionInboxOf(entry({ "next-turn": [{ id: "a" }], "next-step": [] })), { running: false, queued: 1 });
  assert.deepEqual(sessionInboxOf(entry({ "next-turn": [{ id: "a" }, { id: "b" }], "next-step": [{ id: "c" }] }, true)), { running: true, queued: 3 });
  // A reply without the projection, a malformed inbox and no entry at all say nothing — and nothing is not "empty".
  for (const unsaid of [undefined, null, {}, { running: false }, { projections: { values: {} } }, entry({}), entry({ "next-turn": [] }), entry({ "next-turn": "x", "next-step": [] }), entry(null)]) {
    assert.equal(sessionInboxOf(/** @type {any} */ (unsaid)), null, JSON.stringify(unsaid));
  }
});
