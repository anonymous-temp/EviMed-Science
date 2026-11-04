import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ResearchGoals } from "../src/researchGoalService.mjs";

const T0 = Date.UTC(2026, 10, 3, 10, 0);
const iso = (ms) => new Date(ms).toISOString();

/** A goal's world, with every outside thing it acts through written down. */
async function world({ runs = [], limits = {}, bar = {}, runtime = { running: true, startedAt: iso(T0 - 3_600_000) } } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "goal-"));
  await mkdir(path.join(dir, "knowledge-base"));
  const project = { id: "p", userId: "u", workspaceDir: dir };
  const docs = new Map();
  const calls = { bar: [], dispatch: [], steer: [], cancel: [], notify: [] };
  const state = { now: T0, runs, runtime, bar: { read: { result: { kind: "present", snapshot: { goalId: "g", loopxAgentId: "a", goalActivation: "active", progress: { processed: 1, remaining: 1, total: 2 } } } }, action: { result: { kind: "succeeded" } }, ...bar } };
  const documents = {
    get: async (_, __, id) => docs.get(id) ?? null,
    put: async (_, __, id, payload, { expectedRevision, projectId }) => {
      const had = docs.get(id);
      if ((had?.revision ?? 0) !== expectedRevision) { const error = new Error("conflict"); error.status = 409; throw error; }
      const saved = { id, payload, revision: expectedRevision + 1, projectId };
      docs.set(id, saved);
      return saved;
    },
    list: async () => ({ items: [...docs.values()] }),
  };
  const goals = new ResearchGoals({
    documents,
    database: { query: async () => ({ rows: [...docs.values()].filter((doc) => doc.payload.status === "active" || doc.payload.status === "paused" || doc.payload.pauseUnconfirmed === true).map((doc) => ({ user_id: "u", project_id: "p", session_id: doc.payload.sessionId })) }) },
    agentRuns: { list: async () => state.runs },
    runtimeManager: {
      goalBar: async (_, payload) => { calls.bar.push(payload); return payload.op === "read" ? state.bar.read : state.bar.action; },
      status: async () => state.runtime,
      startWhenRoom: async () => {},
    },
    store: { userById: async () => ({ id: "u" }), requireProject: async () => project },
    dispatchTurn: async (_, turn) => { calls.dispatch.push(turn); },
    steerRound: async (_, run, text) => { calls.steer.push({ run: run.id, text }); },
    cancelRound: async (_, run) => { calls.cancel.push(run.id); },
    notify: async (_, item) => { calls.notify.push(item); },
    limits: { quietMs: 180_000, maxRoundsWithoutProgress: 3, maxCny: 50, reviveAttempts: 3, reviveBackoffMs: [30_000, 300_000, 900_000], staleMs: 48 * 3_600_000, tickMs: 30_000, ...limits },
    now: () => new Date(state.now),
  });
  return { goals, project, state, calls, docs, close: () => rm(dir, { recursive: true, force: true }), dir };
}
const setting = (over = {}) => ({ id: "r0", sessionId: "s", effectiveRouteReason: "research-goal", question: "评估 SGLT2", status: "succeeded", startedAt: iso(T0 - 600_000), finishedAt: iso(T0 - 500_000), artifacts: ["report.md"], usage: { costCny: 1 }, ...over });
const round = (n, over = {}) => ({ id: `c${n}`, sessionId: "s", automated: true, effectiveRouteReason: "adopted:runtime-ui:loopx-continuation", goal: { id: "g", runId: "r0" }, status: "succeeded", startedAt: iso(T0 - 400_000 + n * 1000), finishedAt: iso(T0 - 400_000 + n * 1000 + 500), artifacts: [], usage: { costCny: 0.01 }, ...over });

test("a third round without a file pauses the goal on LoopX's bar, and the person hears why", async () => {
  const w = await world({ runs: [setting(), round(1), round(2), round(3)] });
  try {
    await w.goals.observeRound(w.project, w.state.runs.at(-1));
    const { payload } = w.docs.get("goal-s");
    assert.equal(payload.status, "paused");
    assert.equal(payload.reason, "no_progress");
    assert.equal(payload.pauseUnconfirmed, false);
    assert.deepEqual(w.calls.bar.map((call) => call.op), ["read", "pause"]);
    assert.deepEqual(w.calls.bar[1].expected, { goalId: "g", loopxAgentId: "a" });
    assert.equal(w.calls.notify[0].title, "研究已暂停");
    assert.match(w.calls.notify[0].body, /连续 3 轮没有新的产出/);
    assert.match(w.calls.notify[0].body, /评估 SGLT2/);
    assert.equal(w.calls.notify[0].groupKey, "goal-state:s", "its own item: the next round's notice must not overwrite it");
  } finally { await w.close(); }
});

test("past its spend limit a goal is paused, whatever its rounds left", async () => {
  const w = await world({ runs: [setting({ usage: { costCny: 49 } }), round(1, { usage: { costCny: 2 }, artifacts: ["n.md"] })] });
  try {
    await w.goals.observeRound(w.project, w.state.runs.at(-1));
    assert.equal(w.docs.get("goal-s").payload.reason, "budget");
    assert.match(w.calls.notify[0].body, /花费上限/);
  } finally { await w.close(); }
});

test("a pause the bar cannot confirm stops the next automatic round instead, and is asked again", async () => {
  const w = await world({ runs: [setting(), round(1), round(2), round(3)], bar: { read: { result: { kind: "fault", code: "session_unavailable" } } } });
  try {
    await w.goals.observeRound(w.project, w.state.runs.at(-1));
    assert.equal(w.docs.get("goal-s").payload.pauseUnconfirmed, true);
    w.state.runs = [...w.state.runs, round(4, { status: "running", finishedAt: null })];
    await w.goals.tick();
    assert.deepEqual(w.calls.cancel, ["c4"]);
    w.state.runs = w.state.runs.map((run) => (run.id === "c4" ? { ...run, status: "canceled", canceledBy: "platform", errorCode: "runtime_canceled" } : run));
    w.state.bar.read = { result: { kind: "present", snapshot: { goalId: "g", loopxAgentId: "a", goalActivation: "stopped", progress: { processed: 1, remaining: 1, total: 2 } } } };
    await w.goals.tick();
    assert.equal(w.docs.get("goal-s").payload.pauseUnconfirmed, false);
    assert.equal(w.docs.get("goal-s").payload.status, "paused");
    assert.equal(w.calls.dispatch.length, 0, "a paused goal is not taken up again");
  } finally { await w.close(); }
});

test("a person's stop is a stop: the goal rests, and is not taken up again", async () => {
  const stopped = round(1, { status: "canceled", canceledBy: "user", errorCode: "runtime_canceled" });
  const w = await world({ runs: [setting(), stopped] });
  try {
    await w.goals.observeRound(w.project, stopped);
    assert.equal(w.docs.get("goal-s").payload.status, "stopped");
    w.state.now = T0 + 3_600_000;
    await w.goals.tick();
    assert.equal(w.calls.dispatch.length, 0);
  } finally { await w.close(); }
});

test("a turn that takes a goal up says only to go on: the instruction is in the run's context, where memory never reads it as the person's", async () => {
  const w = await world({ runs: [setting(), round(1, { artifacts: ["n.md"], status: "failed", errorCode: "runtime_stopped", finishedAt: iso(T0 - 120_000) })] });
  try {
    await w.goals.observeRound(w.project, w.state.runs.at(-1));
    await w.goals.tick();
    const [turn] = w.calls.dispatch;
    assert.equal(turn.text, "继续这项研究。");
    assert.match(turn.system, /<evimed-research-goal>[\s\S]*interrupted[\s\S]*<\/evimed-research-goal>/);
  } finally { await w.close(); }
});

test("a person's stop after a pause the bar could not confirm stays a stop: it is not read as an interruption", async () => {
  const w = await world({ runs: [setting(), round(1, { artifacts: ["n.md"] })], bar: { read: { result: { kind: "fault", code: "runtime_not_running" } } } });
  try {
    await w.goals.pause(w.project, "s");
    assert.equal(w.docs.get("goal-s").payload.pauseUnconfirmed, true);
    const stopped = round(2, { status: "canceled", canceledBy: "user", errorCode: "runtime_canceled", startedAt: iso(T0 + 60_000), finishedAt: iso(T0 + 90_000) });
    w.state.runs = [...w.state.runs, stopped];
    w.state.now = T0 + 120_000;
    await w.goals.observeRound(w.project, stopped);
    const after = w.docs.get("goal-s").payload;
    assert.equal(after.status, "stopped");
    assert.equal(after.pauseUnconfirmed, false);
    w.state.now = T0 + 900_000;
    await w.goals.tick();
    assert.equal(w.docs.get("goal-s").payload.status, "stopped");
    assert.equal(w.calls.notify.length, 0, "nobody is told a stop was an interruption");
    assert.equal(w.calls.dispatch.length, 0);
  } finally { await w.close(); }
});

test("a round the platform ended is taken up again with one turn, after the first backoff, and only then", async () => {
  const killed = round(1, { status: "failed", errorCode: "runtime_stopped", finishedAt: iso(T0 - 10_000) });
  const w = await world({ runs: [setting(), killed] });
  try {
    await w.goals.observeRound(w.project, killed);
    await w.goals.tick();
    assert.equal(w.calls.dispatch.length, 0, "inside the backoff");
    w.state.now = T0 + 25_000;
    await w.goals.tick();
    assert.equal(w.calls.dispatch.length, 1);
    assert.equal(w.calls.dispatch[0].route, "research-goal-resume");
    assert.equal(w.calls.dispatch[0].question, "评估 SGLT2", "kept under the goal's own question");
    assert.equal(w.docs.get("goal-s").payload.revive.attempts, 1);
    await w.goals.tick();
    assert.equal(w.calls.dispatch.length, 1, "not twice in one backoff");
  } finally { await w.close(); }
});

test("after its attempts a goal the platform keeps ending waits for a person, who is told", async () => {
  const killed = round(1, { status: "failed", errorCode: "runtime_stopped", finishedAt: iso(T0 - 10_000) });
  const w = await world({ runs: [setting(), killed] });
  try {
    await w.goals.observeRound(w.project, killed);
    for (const step of [60_000, 400_000, 1_400_000, 1_500_000]) { w.state.now = T0 + step; await w.goals.tick(); }
    assert.equal(w.calls.dispatch.length, 3);
    assert.equal(w.docs.get("goal-s").payload.status, "interrupted");
    assert.equal(w.calls.notify.at(-1).title, "研究中断了");
  } finally { await w.close(); }
});

test("a round that succeeded starts the count of attempts again", async () => {
  const killed = round(1, { status: "failed", errorCode: "runtime_stopped", finishedAt: iso(T0 - 10_000) });
  const w = await world({ runs: [setting(), killed] });
  try {
    await w.goals.observeRound(w.project, killed);
    w.state.now = T0 + 60_000;
    await w.goals.tick();
    assert.equal(w.docs.get("goal-s").payload.revive.attempts, 1);
    const good = round(2, { artifacts: ["n.md"], startedAt: iso(T0 + 61_000), finishedAt: iso(T0 + 62_000) });
    w.state.runs = [...w.state.runs, good];
    await w.goals.observeRound(w.project, good);
    assert.equal(w.docs.get("goal-s").payload.revive.attempts, 0);
  } finally { await w.close(); }
});

test("a first turn that came back with nothing is set again with the gesture, because LoopX never heard of it", async () => {
  const empty = setting({ status: "failed", errorCode: "model_empty_reply", artifacts: [], finishedAt: iso(T0 - 60_000) });
  const w = await world({ runs: [empty] });
  try {
    await w.goals.register(w.project, { sessionId: "s" });
    await w.goals.tick();
    assert.equal(w.calls.dispatch.length, 1);
    assert.equal(w.calls.dispatch[0].route, "research-goal-retry");
    assert.equal(w.calls.dispatch[0].text, "/loopx 评估 SGLT2");
    assert.match(w.calls.dispatch[0].system, /evimed-research-goal/);
  } finally { await w.close(); }
});

test("quiet with its kernel up: LoopX says whether the work is done", async () => {
  const w = await world({ runs: [setting(), round(1, { artifacts: ["n.md"] })], bar: { read: { result: { kind: "present", snapshot: { goalId: "g", loopxAgentId: "a", goalActivation: "active", progress: { processed: 2, remaining: 0, total: 2 } } } } } });
  try {
    await w.goals.register(w.project, { sessionId: "s" });
    w.state.now = T0 - 390_000 + 60_000;
    await w.goals.tick();
    assert.equal(w.docs.get("goal-s").payload.status, "active", "inside the gap two rounds can have");
    w.state.now = T0 + 60_000;
    await w.goals.tick();
    assert.equal(w.docs.get("goal-s").payload.status, "finished");
    assert.deepEqual(w.docs.get("goal-s").payload.progress, { processed: 2, total: 2 });
    assert.equal(w.calls.notify[0].title, "研究完成了");
  } finally { await w.close(); }
});

test("quiet with work left and its kernel up: it waits for someone, and is not spent on", async () => {
  const w = await world({ runs: [setting(), round(1, { artifacts: ["n.md"] })] });
  try {
    await w.goals.register(w.project, { sessionId: "s" });
    w.state.now = T0 + 60_000;
    await w.goals.tick();
    assert.equal(w.docs.get("goal-s").payload.status, "waiting");
    assert.equal(w.calls.dispatch.length, 0);
  } finally { await w.close(); }
});

test("a kernel that came back without the driver armed: work left is taken up, work done is not", async () => {
  const runs = [setting(), round(1, { artifacts: ["n.md"] })];
  const restarted = { running: true, startedAt: iso(T0 - 1000) };
  const w = await world({ runs, runtime: restarted, bar: { read: { result: { kind: "fault", code: "session_unavailable" } } } });
  try {
    await w.goals.register(w.project, { sessionId: "s" });
    w.state.now = T0 + 60_000;
    await w.goals.tick();
    assert.equal(w.calls.dispatch.length, 1, "the bar could not say, so the goal is told to go on");
    assert.equal(w.calls.dispatch[0].route, "research-goal-resume");
  } finally { await w.close(); }
  const done = await world({ runs, runtime: restarted, bar: { read: { result: { kind: "present", snapshot: { goalId: "g", loopxAgentId: "a", goalActivation: "active", progress: { processed: 2, remaining: 0, total: 2 } } } } } });
  try {
    await done.goals.register(done.project, { sessionId: "s" });
    done.state.now = T0 + 60_000;
    await done.goals.tick();
    assert.equal(done.calls.dispatch.length, 0);
    assert.equal(done.docs.get("goal-s").payload.status, "finished");
  } finally { await done.close(); }
});

test("a goal silent for days is not started on its own", async () => {
  const w = await world({ runs: [setting(), round(1, { artifacts: ["n.md"] })], runtime: { running: false, startedAt: null } });
  try {
    await w.goals.register(w.project, { sessionId: "s" });
    w.state.now = T0 + 72 * 3_600_000;
    await w.goals.tick();
    assert.equal(w.calls.dispatch.length, 0);
    assert.equal(w.docs.get("goal-s").payload.status, "interrupted");
    assert.equal(w.docs.get("goal-s").payload.reason, "stale");
  } finally { await w.close(); }
});

test("a file connected while a round runs is said to that round, once, by name", async () => {
  const live = round(1, { status: "running", finishedAt: null });
  const w = await world({ runs: [setting(), live] });
  try {
    await writeFile(path.join(w.dir, "knowledge-base", "old.csv"), "a");
    await w.goals.register(w.project, { sessionId: "s" });
    await w.goals.tick();
    assert.equal(w.calls.steer.length, 0, "what was there when the goal was set is its own to read");
    await writeFile(path.join(w.dir, "knowledge-base", "trial-list.csv"), "b");
    await writeFile(path.join(w.dir, "knowledge-base", ".evimed-derived"), "c");
    await w.goals.tick();
    assert.equal(w.calls.steer.length, 1);
    assert.equal(w.calls.steer[0].run, "c1");
    assert.match(w.calls.steer[0].text, /trial-list\.csv/);
    assert.doesNotMatch(w.calls.steer[0].text, /old\.csv|evimed-derived/);
    await w.goals.tick();
    assert.equal(w.calls.steer.length, 1);
  } finally { await w.close(); }
});

test("a round LoopX starts after a pause is stopped and does not count as the goal going again; one going when the pause came is let finish", async () => {
  const going = round(1, { status: "running", finishedAt: null, startedAt: new Date(T0 - 60_000).toISOString() });
  const w = await world({ runs: [setting(), going], bar: { read: { result: { kind: "present", snapshot: { goalId: "g", loopxAgentId: "a", goalActivation: "stopped", agentStatus: "running", progress: {} } } } } });
  try {
    w.state.now = T0;
    await w.goals.noteBarAction(w.project, "s", "pause");
    assert.equal(w.docs.get("goal-s").payload.status, "paused");
    await w.goals.tick();
    assert.equal(w.calls.cancel.length, 0, "the round going when the pause came finishes");

    const recovery = round(2, { status: "running", finishedAt: null, startedAt: new Date(T0 + 30_000).toISOString() });
    w.state.runs = [setting(), { ...going, status: "succeeded", finishedAt: new Date(T0 + 10_000).toISOString() }, recovery];
    w.state.now = T0 + 40_000;
    await w.goals.tick();
    assert.deepEqual(w.calls.cancel, ["c2"]);
    assert.equal(w.docs.get("goal-s").payload.status, "paused");

    await w.goals.observeRound(w.project, { ...recovery, status: "canceled", canceledBy: "platform", errorCode: "runtime_canceled", finishedAt: new Date(T0 + 45_000).toISOString() });
    assert.equal(w.docs.get("goal-s").payload.status, "paused", "LoopX's own round is not someone taking the goal up");
  } finally { await w.close(); }
});

test("rounds too short to be seen running are stopped too: a round that began after the pause is itself the sign, and only while the driver is still trying", async () => {
  const stopped = { read: { result: { kind: "present", snapshot: { goalId: "g", loopxAgentId: "a", goalActivation: "stopped", agentStatus: "idle", progress: {} } } } };
  const w = await world({ runs: [setting(), round(1)], bar: stopped });
  try {
    w.state.now = T0;
    await w.goals.noteBarAction(w.project, "s", "pause");
    // A round the ledger only ever saw finished, thirteen seconds long.
    const brief = round(2, { startedAt: iso(T0 + 20_000), finishedAt: iso(T0 + 33_000) });
    w.state.runs = [setting(), round(1), brief];
    w.state.now = T0 + 40_000;
    await w.goals.tick();
    assert.deepEqual(w.calls.cancel, ["c2"], "the kernel's turn is stopped through the session, which needs no live record");
    assert.equal(w.docs.get("goal-s").payload.status, "paused");

    // Nothing new for a while: nothing is trying, so nothing is stopped.
    w.calls.cancel.length = 0;
    w.state.now = T0 + 300_000;
    await w.goals.tick();
    assert.equal(w.calls.cancel.length, 0);

    // A person's own turn after the pause is theirs.
    const mine = { ...round(3), id: "p1", automated: false, effectiveRouteReason: "default", status: "running", finishedAt: null, startedAt: iso(T0 + 310_000) };
    w.state.runs = [setting(), round(1), brief, mine];
    w.state.now = T0 + 320_000;
    await w.goals.tick();
    assert.equal(w.calls.cancel.length, 0);
  } finally { await w.close(); }
});

test("a goal someone started on the bar is not held: the bar's word is asked before a round is stopped, and a person's message takes a paused goal up", async () => {
  const w = await world({ runs: [setting(), round(1)], bar: { read: { result: { kind: "present", snapshot: { goalId: "g", loopxAgentId: "a", goalActivation: "active", agentStatus: "running", progress: {} } } } } });
  try {
    w.state.now = T0;
    await w.goals.noteBarAction(w.project, "s", "pause");
    w.state.runs = [setting(), round(1), round(2, { status: "running", finishedAt: null, startedAt: new Date(T0 + 30_000).toISOString() })];
    w.state.now = T0 + 40_000;
    await w.goals.tick();
    assert.equal(w.calls.cancel.length, 0);
    assert.equal(w.docs.get("goal-s").payload.status, "active");

    await w.goals.noteBarAction(w.project, "s", "pause");
    const mine = { ...round(3), id: "p1", automated: false, effectiveRouteReason: "default", startedAt: new Date(T0 + 60_000).toISOString(), finishedAt: new Date(T0 + 70_000).toISOString() };
    await w.goals.observeRound(w.project, mine);
    assert.equal(w.docs.get("goal-s").payload.status, "active");
  } finally { await w.close(); }
});

test("a bar action in a session with no goal is no concern of the goal's", async () => {
  const w = await world({ runs: [] });
  try {
    await w.goals.noteBarAction(w.project, "s", "pause");
    assert.equal(w.docs.size, 0);
  } finally { await w.close(); }
});

test("a goal just taken up has not been quiet since the round before: no state is read off it until it has been, and a kernel at a turn is no resting goal", async () => {
  const present = (agentStatus) => ({ read: { result: { kind: "present", snapshot: { goalId: "g", loopxAgentId: "a", goalActivation: "active", agentStatus, progress: { total: 3, remaining: 1, processed: 2 } } } } });
  const w = await world({ runs: [setting(), round(1)], bar: present("running") });
  try {
    await w.goals.observeRound(w.project, w.state.runs.at(-1));
    await w.goals.noteBarAction(w.project, "s", "start");
    const started = Date.parse(w.docs.get("goal-s").payload.statusAt);
    w.state.now = started + 60_000;
    await w.goals.tick();
    assert.equal(w.docs.get("goal-s").payload.status, "active", "a minute after 继续, whatever the last round's age");
    w.state.now = started + 200_000;
    await w.goals.tick();
    assert.equal(w.docs.get("goal-s").payload.status, "active", "the bar says a turn is going, the ledger has not seen it yet");
  } finally { await w.close(); }
});

test("a file connected while a person's own turn runs is not written into it: that would read as their statement, so the next unattended round is told", async () => {
  const mine = { ...round(1, { status: "running", finishedAt: null }), id: "p1", automated: false, effectiveRouteReason: "default" };
  const w = await world({ runs: [setting(), mine] });
  try {
    await w.goals.register(w.project, { sessionId: "s" });
    await writeFile(path.join(w.dir, "knowledge-base", "trial-list.csv"), "b");
    await w.goals.tick();
    assert.equal(w.calls.steer.length, 0);
    w.state.runs = [setting(), { ...mine, status: "succeeded", finishedAt: new Date(T0).toISOString() }, round(2, { status: "running", finishedAt: null })];
    await w.goals.tick();
    assert.equal(w.calls.steer.length, 1);
    assert.equal(w.calls.steer[0].run, "c2");
    assert.match(w.calls.steer[0].text, /trial-list\.csv/);
  } finally { await w.close(); }
});

test("继续 starts a goal LoopX stopped on its bar, and the limits count from there", async () => {
  const w = await world({ runs: [setting(), round(1), round(2), round(3)], bar: { read: { result: { kind: "present", snapshot: { goalId: "g", loopxAgentId: "a", goalActivation: "stopped", progress: { processed: 1, remaining: 1, total: 2 } } } } } });
  try {
    await w.goals.observeRound(w.project, w.state.runs.at(-1));
    assert.equal(w.docs.get("goal-s").payload.status, "paused");
    w.state.now = T0 + 100_000;
    await w.goals.resume(w.project, "s");
    assert.equal(w.calls.bar.at(-1).op, "start");
    assert.equal(w.calls.dispatch.length, 0);
    const { payload } = w.docs.get("goal-s");
    assert.equal(payload.status, "active");
    assert.equal(payload.guardSince, iso(T0 + 100_000));
    const next = round(9, { startedAt: iso(T0 + 110_000), finishedAt: iso(T0 + 111_000) });
    w.state.runs = [...w.state.runs, next];
    await w.goals.observeRound(w.project, next);
    assert.equal(w.docs.get("goal-s").payload.status, "active", "one empty round since the person asked is not three");
  } finally { await w.close(); }
});

test("继续 with the bar unable to say tells the goal to go on, and starts it on the bar as soon as it can", async () => {
  const stopped = round(1, { status: "canceled", canceledBy: "user", errorCode: "runtime_canceled" });
  const w = await world({ runs: [setting(), stopped], bar: { read: { result: { kind: "fault", code: "session_unavailable" } } } });
  try {
    await w.goals.observeRound(w.project, stopped);
    await w.goals.resume(w.project, "s");
    assert.equal(w.calls.dispatch.length, 1);
    assert.match(w.calls.dispatch[0].text, /继续/);
    assert.equal(w.docs.get("goal-s").payload.startOnBar, true);
    w.state.bar.read = { result: { kind: "present", snapshot: { goalId: "g", loopxAgentId: "a", goalActivation: "stopped", progress: { processed: 0, remaining: 1, total: 1 } } } };
    await w.goals.tick();
    assert.equal(w.calls.bar.at(-1).op, "start");
    assert.equal(w.docs.get("goal-s").payload.startOnBar, false);
  } finally { await w.close(); }
});

test("继续 while a round is running is refused; a session with no goal is not found", async () => {
  const w = await world({ runs: [setting(), round(1, { status: "running", finishedAt: null })] });
  try {
    await w.goals.register(w.project, { sessionId: "s" });
    await assert.rejects(w.goals.resume(w.project, "s"), (error) => error.code === "agent_run_active");
    await assert.rejects(w.goals.pause(w.project, "nobody"), (error) => error.code === "research_goal_not_found");
  } finally { await w.close(); }
});

test("a round that began after a goal came to rest means someone took it up", async () => {
  const w = await world({ runs: [setting(), round(1, { artifacts: ["n.md"] })] });
  try {
    await w.goals.pause(w.project, "s");
    assert.equal(w.docs.get("goal-s").payload.status, "paused");
    w.state.now = T0 + 10_000;
    const mine = { ...round(2), id: "p1", automated: false, effectiveRouteReason: "default", startedAt: iso(T0 + 5000), finishedAt: iso(T0 + 8000) };
    w.state.runs = [...w.state.runs, mine];
    await w.goals.observeRound(w.project, mine);
    assert.equal(w.docs.get("goal-s").payload.status, "active");

    // A goal that was only waiting: LoopX going on is as good as anyone taking it up.
    await w.goals.observeRound(w.project, round(3, { artifacts: ["m.md"] }));
    const waiting = w.docs.get("goal-s");
    w.docs.set("goal-s", { ...waiting, payload: { ...waiting.payload, status: "waiting", statusAt: iso(T0 + 9000) } });
    const next = round(4, { artifacts: ["k.md"], startedAt: iso(T0 + 9500), finishedAt: iso(T0 + 9800) });
    await w.goals.observeRound(w.project, next);
    assert.equal(w.docs.get("goal-s").payload.status, "active");
    assert.equal(w.docs.get("goal-s").payload.goalId, "g");
  } finally { await w.close(); }
});

test("a session with no goal is nothing to the service, and a failure inside it costs the run nothing", async () => {
  const w = await world({ runs: [{ id: "x", sessionId: "s", question: "你好", status: "succeeded", startedAt: iso(T0) }] });
  try {
    await w.goals.observeRound(w.project, w.state.runs[0]);
    assert.equal(w.docs.size, 0);
    w.goals.agentRuns = { list: async () => { throw new Error("no"); } };
    await w.goals.observeRound(w.project, { sessionId: "s" });
  } finally { await w.close(); }
});

test("while the deployment is held the pass stands down", async () => {
  const w = await world({ runs: [setting(), round(1, { status: "failed", errorCode: "runtime_stopped", finishedAt: iso(T0 - 100_000) })] });
  try {
    await w.goals.register(w.project, { sessionId: "s" });
    w.goals.claimingAllowed = () => false;
    await w.goals.tick();
    assert.equal(w.calls.dispatch.length, 0);
    w.goals.claimingAllowed = () => true;
    await w.goals.tick();
    assert.equal(w.calls.dispatch.length, 1);
  } finally { await w.close(); }
});
