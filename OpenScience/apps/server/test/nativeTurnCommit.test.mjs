// A native account's conversation reaches the engine's extraction after each attended turn.
//
// The unmodified memory plugin commits a session only at 20000 pending tokens and when it is disposed; an ordinary
// conversation is a few hundred tokens and a runtime lives for hours, so on production (2026-10-14) a stated profession, a
// city and three project facts were not in memory twenty minutes later and `native_commits` held no row of the session.
// These tests hold what makes the control plane's commit safe to make for every attended turn: it happens after a short
// exchange far below the threshold and after the plugin's writes, through the gateway's own commit path (its ledger, its
// hourly bound, its admission), once for two quick turns, and never for a turn the platform started, a legacy account, a
// paused conversation or a person who is already typing again. The last test drives the real plugin's own capture and
// commit logic (the pinned archive) through the gateway against the engine stub.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createMemoryAdmission } from "../src/memoryAdmission.mjs";
import { MEMORY_GATEWAY_PATH, createMemoryGatewayHandler } from "../src/memoryGateway.mjs";
import { nativeMemoryCounters, resetNativeMemoryMetrics } from "../src/nativeMemoryMetrics.mjs";
import { NativeTurnCommit } from "../src/nativeTurnCommit.mjs";
import { OpenVikingClient } from "../src/openVikingClient.mjs";
import { openVikingUserId } from "../src/openVikingLayout.mjs";
import { OpenVikingSessions } from "../src/openVikingSessions.mjs";
import { startOpenVikingStub } from "./helpers/openVikingStub.mjs";

const TOKEN = "workload-token-for-tests";
const USER = "user-a";
const OV_USER = openVikingUserId(USER);
const CONVERSATION = "session_0123456789abcdef0123456789abcdef";
const ENGINE_SESSION = `dsh-${CONVERSATION}`;
const project = (id = "p1") => ({ id, userId: USER });
const finished = (extra = {}) => ({ id: "run-1", sessionId: CONVERSATION, status: "succeeded", ...extra });
const counters = () => nativeMemoryCounters().turnCommits;

/** A clock the test turns by hand: timers wait for `fire`, and waits between reads are instant. */
function clock() {
  /** @type {Set<{ fn: () => void, ms: number }>} */
  const timers = new Set();
  return {
    setTimer: (fn, ms) => { const timer = { fn, ms }; timers.add(timer); return timer; },
    clearTimer: (timer) => { timers.delete(timer); },
    wait: async () => {},
    get armed() { return timers.size; },
    delays: () => [...timers].map((timer) => timer.ms),
    fire: () => { for (const timer of [...timers]) { timers.delete(timer); timer.fn(); } },
  };
}

const memoryDouble = ({ engine = "native", settings = {} } = {}) => ({
  configured: true,
  memoryEngine: async () => engine,
  settings: async () => ({ learningPaused: false, recallPaused: false, pausedProjects: [], ...settings }),
  sessionState: async () => ({ trialCapsuleId: null }),
});

const baseConfig = { ovNativeMemoryEnabled: true, memoryEnabled: true, nativeMemoryTurnCommitDebounceMs: 8_000, nativeMemoryTurnCommitSettleMs: 2_000, nativeMemoryTurnCommitAttempts: 4 };

/**
 * A committer over doubles. `states` is what reading the engine's session answers, one entry per read (the last repeats);
 * `runs` is the conversation's runs as the ledger folds them.
 */
function doubles({ states = [{ pending_tokens: 100, message_count: 2 }], engine = "native", config = {}, runs = [], admit = null, commit = null, settings = {} } = {}) {
  resetNativeMemoryMetrics();
  const time = clock();
  const reads = [];
  const commits = [];
  let read = 0;
  const sessions = {
    configured: true,
    readSession: async (userId, sessionId) => {
      reads.push([userId, sessionId]);
      const state = states[Math.min(read++, states.length - 1)];
      if (state instanceof Error) throw state;
      return { status: "ok", result: state };
    },
  };
  const admission = admit ?? createMemoryAdmission({ config: baseConfig, researchMemory: memoryDouble({ engine, settings }), conversations: {
    running: async () => runs.filter((run) => run.status === "running"),
    runsOf: async (_project, id) => runs.filter((run) => run.sessionId === id),
  } });
  const committer = new NativeTurnCommit({
    config: { ...baseConfig, ...config }, researchMemory: memoryDouble({ engine, settings }), sessions, admission,
    conversations: { runsOf: async (_project, id) => runs.filter((run) => run.sessionId === id) },
    commit: commit ?? (async (request) => { commits.push(request); return { commit: "accepted" }; }),
    setTimer: time.setTimer, clearTimer: time.clearTimer, wait: time.wait,
  });
  return { committer, time, reads, commits, runs };
}

test("a short exchange of a native account is committed after the quiet, far below the plugin's own threshold", async () => {
  const { committer, time, reads, commits } = doubles({ states: [{ pending_tokens: 140, message_count: 2 }] });
  await committer.noteRunFinished(project(), finished());
  assert.equal(time.armed, 1);
  assert.deepEqual(time.delays(), [8_000], "armed for the configured quiet");
  assert.deepEqual([reads.length, commits.length], [0, 0], "nothing is asked of the engine before the quiet has passed");
  time.fire();
  await committer.idle();
  assert.deepEqual(commits.map((request) => [request.user.id, request.engineSessionId, request.project.id]), [[USER, ENGINE_SESSION, "p1"]]);
  assert.ok(reads.every(([userId, sessionId]) => userId === USER && sessionId === ENGINE_SESSION));
  assert.equal(reads.length, 2, "two reads that agree");
  assert.equal(counters().scheduled, 1);
  assert.equal(counters().committed, 1);
});

test("a turn the platform started, and a legacy account, arm nothing and ask the engine nothing", async () => {
  const automated = doubles();
  for (const run of [{ automated: true }, { effectiveRouteReason: "autopilot:agenda-1" }, { routeReason: "autopilot:digest" }, { effectiveRouteReason: "loopx-continuation" }, { effectiveRouteReason: "adopted:runtime-ui:loopx-continuation" }]) {
    await automated.committer.noteRunFinished(project(), finished(run));
  }
  assert.equal(automated.time.armed, 0);
  assert.equal(counters().platform_started, 5);
  automated.time.fire();
  await automated.committer.idle();
  assert.deepEqual([automated.reads.length, automated.commits.length], [0, 0]);

  const legacy = doubles({ engine: "legacy" });
  await legacy.committer.noteRunFinished(project(), finished());
  assert.equal(legacy.time.armed, 0);
  assert.deepEqual(Object.values(counters()).reduce((sum, value) => sum + value, 0), 0, "a legacy account is not even counted");
  assert.deepEqual([legacy.reads.length, legacy.commits.length], [0, 0]);

  // The platform's own projects, a run with no conversation, and a switched-off committer.
  const others = doubles();
  await others.committer.noteRunFinished(project("evimed-learning"), finished());
  await others.committer.noteRunFinished(project(), finished({ sessionId: "" }));
  await others.committer.noteRunFinished(project(), finished({ sessionId: "../x" }));
  assert.equal(others.time.armed, 0);
  const off = doubles({ config: { nativeMemoryTurnCommitEnabled: false } });
  assert.equal(off.committer.applicable, false);
  await off.committer.noteRunFinished(project(), finished());
  assert.equal(off.time.armed, 0);
});

test("two quick turns are one commit: the second re-arms the quiet", async () => {
  const { committer, time, commits } = doubles({ states: [{ pending_tokens: 400, message_count: 4 }] });
  await committer.noteRunFinished(project(), finished());
  await committer.noteRunFinished(project(), finished({ id: "run-2" }));
  assert.equal(time.armed, 1, "one timer for the conversation");
  time.fire();
  await committer.idle();
  assert.equal(commits.length, 1);
  assert.deepEqual([counters().scheduled, counters().debounced, counters().committed], [2, 1, 1]);
  // Another conversation of the same account is its own commit.
  await committer.noteRunFinished(project(), finished({ sessionId: "session_other" }));
  await committer.noteRunFinished(project(), finished());
  assert.equal(time.armed, 2);
});

test("a person who is typing again is left to their own turn's end; a platform-started turn running does not hold the commit", async () => {
  const typing = doubles({ runs: [{ id: "run-2", sessionId: CONVERSATION, status: "running", startedAt: "2026-10-14T01:00:10Z" }] });
  await typing.committer.noteRunFinished(project(), finished());
  typing.time.fire();
  await typing.committer.idle();
  assert.deepEqual([typing.reads.length, typing.commits.length, counters().conversation_running], [0, 0, 1]);

  // A LoopX continuation started inside the quiet: the person's turn before it is still theirs, and commits.
  const continuation = doubles({ runs: [
    { id: "run-2", sessionId: CONVERSATION, status: "running", effectiveRouteReason: "loopx-continuation", startedAt: "2026-10-14T01:00:10Z" },
    { id: "run-1", sessionId: CONVERSATION, status: "succeeded", startedAt: "2026-10-14T01:00:00Z" }] });
  await continuation.committer.noteRunFinished(project(), finished());
  continuation.time.fire();
  await continuation.committer.idle();
  assert.equal(continuation.commits.length, 1);
});

test("nothing pending, no such session and an engine that is down each commit nothing and fake nothing", async () => {
  const nothing = doubles({ states: [{ pending_tokens: 0, message_count: 0 }] });
  await nothing.committer.noteRunFinished(project(), finished());
  nothing.time.fire();
  await nothing.committer.idle();
  assert.deepEqual([nothing.commits.length, nothing.reads.length, counters().nothing_pending], [0, 4, 1], "the configured reads, then nothing pending");

  const unknown = doubles({ states: [Object.assign(new Error("not found"), { code: "memory_index_not_found" })] });
  await unknown.committer.noteRunFinished(project(), finished());
  unknown.time.fire();
  await unknown.committer.idle();
  assert.deepEqual([unknown.commits.length, unknown.reads.length, counters().nothing_pending], [0, 1, 1], "no retry for a session the engine never had");

  const down = doubles({ states: [Object.assign(new Error("down"), { code: "memory_index_unavailable" })] });
  await down.committer.noteRunFinished(project(), finished());
  down.time.fire();
  await down.committer.idle();
  assert.deepEqual([down.commits.length, down.reads.length, counters().failed], [0, 4, 1], "the reads were retried, the commit never made up");

  // The engine answers the reads and then refuses the commit: counted, not swallowed as success, and the conversation went on.
  const refused = doubles({ commit: async () => { throw Object.assign(new Error("502"), { code: "memory_index_unavailable" }); } });
  await refused.committer.noteRunFinished(project(), finished());
  refused.time.fire();
  await refused.committer.idle();
  assert.deepEqual([counters().failed, counters().committed], [1, 0], "counted by the second double: the counters were reset when it was made");
});

test("the plugin's writes of the turn are waited for: the commit follows the first two reads that agree", async () => {
  const { committer, time, reads, commits } = doubles({ states: [
    { pending_tokens: 60, message_count: 1 }, { pending_tokens: 130, message_count: 2 }, { pending_tokens: 130, message_count: 2 }] });
  await committer.noteRunFinished(project(), finished());
  time.fire();
  await committer.idle();
  assert.equal(reads.length, 3);
  assert.equal(commits.length, 1);

  // Writes that never settle are committed on the last read rather than left to the idle commit.
  const busy = doubles({ states: [10, 20, 30, 40].map((count) => ({ pending_tokens: count * 10, message_count: count })) });
  await busy.committer.noteRunFinished(project(), finished());
  busy.time.fire();
  await busy.committer.idle();
  assert.deepEqual([busy.reads.length, busy.commits.length], [4, 1]);
});

test("a conversation that is not learned from costs the engine no read; the gateway's answer for the rest is counted by what it said", async () => {
  for (const settings of [{ learningPaused: true }, { pausedProjects: ["p1"] }]) {
    const paused = doubles({ settings });
    await paused.committer.noteRunFinished(project(), finished());
    paused.time.fire();
    await paused.committer.idle();
    assert.deepEqual([paused.reads.length, paused.commits.length], [0, 0], JSON.stringify(settings));
  }
  assert.equal(counters().not_learning, 1, "counted by the second double: the counters were reset when it was made");
  for (const answer of ["rate_limited", "nothing_pending", "not_learning"]) {
    const asked = doubles({ commit: async () => ({ commit: answer }) });
    await asked.committer.noteRunFinished(project(), finished());
    asked.time.fire();
    await asked.committer.idle();
    assert.equal(counters()[answer], 1, answer);
    assert.equal(counters().committed, 0);
  }
});

test("the bound on waiting conversations and on commits in flight", async () => {
  const bounded = doubles({ config: { nativeMemoryTurnCommitMaxScheduled: 2 } });
  for (const sessionId of ["session_1", "session_2", "session_3"]) await bounded.committer.noteRunFinished(project(), finished({ sessionId }));
  assert.equal(bounded.time.armed, 2);
  assert.equal(counters().dropped, 1);
  await bounded.committer.noteRunFinished(project(), finished({ sessionId: "session_1" }));
  assert.equal(counters().dropped, 1, "a conversation already waiting is re-armed, not dropped");
  assert.equal(bounded.time.armed, 2);

  /** @type {(() => void)[]} */
  const release = [];
  let live = 0;
  let peak = 0;
  const slow = doubles({ config: { nativeMemoryTurnCommitConcurrency: 1 }, commit: async () => {
    live += 1; peak = Math.max(peak, live);
    await new Promise((resolve) => release.push(resolve));
    live -= 1;
    return { commit: "accepted" };
  } });
  for (const sessionId of ["session_1", "session_2"]) await slow.committer.noteRunFinished(project(), finished({ sessionId }));
  slow.time.fire();
  while (release.length < 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(slow.committer.inFlight, 1);
  assert.equal(slow.committer.queue.length, 1, "the second conversation waits for a slot");
  release.shift()();
  while (release.length < 1) await new Promise((resolve) => setImmediate(resolve));
  release.shift()();
  await slow.committer.idle();
  assert.equal(peak, 1);
  assert.equal(counters().committed, 2);
});

test("closing stops everything armed", async () => {
  const { committer, time, commits } = doubles();
  await committer.noteRunFinished(project(), finished());
  committer.close();
  assert.equal(time.armed, 0);
  await committer.noteRunFinished(project(), finished());
  assert.equal(time.armed, 0);
  assert.equal(commits.length, 0);
});

// ---------------------------------------------------------------------------------------------------------------- gateway

/**
 * The real gateway handler over HTTP in front of the engine stub, as the plugin reaches it, with the committer composed the
 * way `server.mjs` composes it.
 */
async function gatewayFixture(t, { settings = {}, config = {}, runs = [] } = {}) {
  resetNativeMemoryMetrics();
  const stub = await startOpenVikingStub(t);
  const client = new OpenVikingClient({ openVikingUrl: stub.url, openVikingApiKey: stub.apiKey, openVikingAccount: "evimed" });
  const sessions = new OpenVikingSessions(client, { timeoutMs: 4_000, fastTimeoutMs: 1_300 });
  const researchMemory = memoryDouble({ settings });
  const conversations = {
    running: async () => runs.filter((run) => run.status === "running"),
    runsOf: async (_project, id) => runs.filter((run) => run.sessionId === id),
  };
  const admission = createMemoryAdmission({ config: baseConfig, researchMemory, conversations });
  /** @type {any[]} */
  const ledger = [];
  const overlay = { configured: true, account: async () => ({ registeredAt: new Date().toISOString() }), noteSession: async () => {}, recordCommit: async (row) => { ledger.push(row); return { inserted: true }; } };
  const handler = createMemoryGatewayHandler({
    config: { ...baseConfig, ...config },
    runtimeManager: { assertActiveEviMedWorkloadToken: async (token) => { if (token === TOKEN) return { userId: USER, projectId: "p1" }; throw new Error("no"); } },
    store: { userById: async (id) => (id === USER ? { id } : null), requireProject: async (_user, id) => ({ id, userId: USER }) },
    sessions, admission, overlay,
  });
  const server = createServer((req, res) => { void handler(req, res); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  const base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}${MEMORY_GATEWAY_PATH}`;
  const time = clock();
  const committer = new NativeTurnCommit({
    config: { ...baseConfig, ...config }, researchMemory, sessions, admission, conversations: { runsOf: conversations.runsOf },
    commit: handler.commitSession, setTimer: time.setTimer, clearTimer: time.clearTimer, wait: time.wait,
  });
  const say = (role, text) => fetch(`${base}/api/v1/sessions/${ENGINE_SESSION}/messages`, {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ role, parts: [{ type: "text", text }] }),
  });
  const open = () => fetch(`${base}/api/v1/sessions`, {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ session_id: ENGINE_SESSION }),
  });
  const finishTurn = async (extra = {}) => {
    await committer.noteRunFinished(project(), finished(extra));
    time.fire();
    await committer.idle();
  };
  return { stub, committer, time, ledger, say, open, finishTurn, handler, gatewayBase: base };
}

test("through the real gateway: the exchange is committed once, into the ledger, and the plugin's disposal commit finds nothing left", async (t) => {
  const { stub, ledger, say, open, finishTurn, handler } = await gatewayFixture(t);
  await open();
  await say("user", "我是心内科的主治医生，在苏州工作，以后回答先给结论再给依据。");
  await say("assistant", "好的，之后我会先给结论，再给依据。");
  assert.equal(stub.sent("POST", `/api/v1/sessions/${ENGINE_SESSION}/commit`).length, 0, "nothing commits it yet: the plugin's threshold is 20000 tokens");
  await finishTurn();
  const commits = stub.sent("POST", `/api/v1/sessions/${ENGINE_SESSION}/commit`);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].user, OV_USER, "as the account the token names, hashed");
  assert.equal(commits[0].headers["x-api-key"], stub.apiKey);
  assert.equal(ledger.length, 1, "the ledger row the worker settles");
  assert.deepEqual([ledger[0].engineSession, ledger[0].projectId, ledger[0].origin, ledger[0].userId], [ENGINE_SESSION, "p1", "gateway", USER]);
  assert.match(ledger[0].archiveUri, /\/sessions\/dsh-session_0123456789abcdef0123456789abcdef\/history\/archive_001$/);
  assert.equal(counters().committed, 1);
  assert.equal(nativeMemoryCounters().commits.accepted, 1);

  // The plugin's disposal commit comes later (the runtime is released): nothing is pending, so no second extraction.
  const late = await handler.commitSession({ user: { id: USER }, project: project(), engineSessionId: ENGINE_SESSION });
  assert.equal(late.commit, "nothing_pending");
  assert.equal(ledger.length, 1);
  assert.equal(nativeMemoryCounters().commits.accepted, 1);
});

test("through the real gateway: the same admission and the same hourly bound as the plugin's own commit", async (t) => {
  const paused = await gatewayFixture(t, { settings: { learningPaused: true } });
  await paused.open();
  await paused.say("user", "我是心内科医生。");
  await paused.finishTurn();
  assert.equal(paused.stub.sent("POST", `/api/v1/sessions/${ENGINE_SESSION}/commit`).length, 0);
  assert.equal(paused.ledger.length, 0);

  const limited = await gatewayFixture(t, { config: { memoryGatewayCommitsPerHour: 1 } });
  await limited.open();
  await limited.say("user", "第一件事：我在苏州工作。");
  await limited.finishTurn();
  await limited.say("user", "第二件事：我的项目是随机对照试验。");
  await limited.finishTurn({ id: "run-2" });
  assert.equal(limited.stub.sent("POST", `/api/v1/sessions/${ENGINE_SESSION}/commit`).length, 1, "the second is over the account's hour");
  assert.deepEqual([counters().committed, counters().rate_limited], [1, 1]);
  assert.equal(nativeMemoryCounters().commits.rate_limited, 1);
  // Over the bound is not lost: the messages are still pending for the next commit or the engine's idle commit.
  const state = await limited.stub.sessions.get(`${OV_USER}/${ENGINE_SESSION}`);
  assert.equal(state.messages.length, 1);

  const automated = await gatewayFixture(t, { runs: [{ id: "run-1", sessionId: CONVERSATION, status: "succeeded", effectiveRouteReason: "autopilot:agenda" }] });
  await automated.open();
  await automated.finishTurn({ effectiveRouteReason: "autopilot:agenda" });
  assert.equal(automated.stub.sent("POST", `/api/v1/sessions/${ENGINE_SESSION}/commit`).length, 0);
});

// ------------------------------------------------------------------------------------------------ the real plugin's logic

/** The pinned plugin archive, unpacked into a scratch directory with the kernel's own package resolvable; null when it is not at hand. */
async function pinnedPlugin(t) {
  const root = new URL("../../../", import.meta.url);
  const pins = JSON.parse(readFileSync(new URL("deps-version.json", root), "utf8"));
  const installer = await import(new URL("deploy/runtime-dsh/install-openviking-plugin.mjs", root).href);
  const pin = installer.openVikingPluginPin(pins);
  const scratch = mkdtempSync(path.join(os.tmpdir(), "ov-turn-plugin-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  try {
    let archive = process.env.OPENVIKING_PLUGIN_ARCHIVE ?? "";
    // Without a local copy the pinned archive is fetched from the registry (digest-checked) where there is a network to count on.
    if (!archive || !existsSync(archive)) {
      if (!process.env.CI) throw new Error("no OPENVIKING_PLUGIN_ARCHIVE, and the registry is fetched only under CI");
      archive = installer.fetchOpenVikingPlugin({ pins: { openviking: { plugin: { ...pin } } }, root: path.join(scratch, "archive") });
    }
    installer.verifyOpenVikingPluginArchive(archive, pin.sha256);
    const dir = path.join(scratch, "node_modules", "@openviking", "dsh-memory-plugin");
    mkdirSync(dir, { recursive: true });
    execFileSync("tar", ["-xzf", archive, "-C", dir, "--strip-components=1"]);
    // The plugin imports the kernel's `@deepseek-ai/dsh-llm`; in the runtime image that is the profile's own copy.
    const harness = new URL("packages/harness-port/node_modules/@deepseek-ai", root);
    mkdirSync(path.join(scratch, "node_modules", "@deepseek-ai"), { recursive: true });
    symlinkSync(path.join(harness.pathname, "dsh-llm"), path.join(scratch, "node_modules", "@deepseek-ai", "dsh-llm"));
    return { dir, scratch };
  } catch (error) {
    t.diagnostic(`the pinned plugin is not available here (${String(/** @type {any} */ (error)?.message ?? error).slice(0, 120)})`);
    return null;
  }
}

test("the real plugin, through the real bridge and gateway: it does not commit a short turn, the turn committer does, and its disposal then extracts nothing again", async (t) => {
  const plugin = await pinnedPlugin(t);
  if (!plugin) { t.skip("the pinned plugin archive is not available (set OPENVIKING_PLUGIN_ARCHIVE to a local copy; CI fetches it)"); return; }
  const { stub, ledger, finishTurn, gatewayBase } = await gatewayFixture(t);
  const { OpenVikingRuntime } = await import(pathToFileURL(path.join(plugin.dir, "runtime.mjs")).href);
  const { OpenVikingClient: PluginClient } = await import(pathToFileURL(path.join(plugin.dir, "client.mjs")).href);
  const { resolveConfig } = await import(pathToFileURL(path.join(plugin.dir, "config.mjs")).href);
  const { createLocalBridgeKey, createMemoryBridge, pinOpenVikingPluginEnvironment } = await import("@evimed/harness-port");

  // The bridge as the runtime runs it: the plugin presents a local key, the bridge puts the workload token on the forward.
  const tokenFile = path.join(plugin.scratch, "token");
  writeFileSync(tokenFile, `${TOKEN}\n`);
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = /** @type {any} */ (probe.address()).port;
  await new Promise((resolve) => probe.close(resolve));
  const localKey = createLocalBridgeKey();
  const bridge = createMemoryBridge({ gatewayUrl: gatewayBase, localKey, tokenFile, port });
  await bridge.listen();
  t.after(() => bridge.close());

  // The plugin as the runtime configures it: its settings stated in the environment, the bridge as its endpoint.
  const home = path.join(plugin.scratch, "home");
  mkdirSync(home, { recursive: true });
  const env = { HOME: home, PATH: process.env.PATH ?? "" };
  pinOpenVikingPluginEnvironment(localKey, env);
  const config = resolveConfig({ endpoint: `http://127.0.0.1:${port}` }, env, plugin.scratch);
  assert.equal(config.commitTokenThreshold, 20000, "the pinned threshold");
  const runtime = new OpenVikingRuntime(new PluginClient(config), config, { debug() {} });
  const session = { id: CONVERSATION, header: { cwd: plugin.scratch } };
  const event = (type, data) => ({ type, data, time: Date.now() });
  const userMessage = (text) => ({ role: "user", content: [{ type: "text", text }], source: { kind: "user" } });
  const assistantMessage = (text) => ({ role: "assistant", content: [{ type: "text", text }] });

  await runtime.initialize({ session, ctx: { effect() {} }, inbox: {} });
  const turn = [
    event("user/message", userMessage("我是心内科的主治医生，在苏州工作。")),
    event("assistant/message", { message: assistantMessage("好的，记下了。") }),
    event("turn/end", {}),
  ];
  for (const item of turn) { runtime.capture(session, item); runtime.maybeCommit(session, item); }
  await runtime.flush(session);
  const commitPath = `/api/v1/sessions/${ENGINE_SESSION}/commit`;
  assert.equal(stub.sessions.get(`${OV_USER}/${ENGINE_SESSION}`)?.messages.length, 2, "the plugin's own writes landed, through the bridge");
  assert.equal(stub.sent("POST", commitPath).length, 0, "and it did not commit them: a few hundred tokens is far below its threshold, the bug this package fixes");

  await finishTurn();
  assert.equal(stub.sent("POST", commitPath).length, 1, "the turn committer did");
  assert.equal(ledger.length, 1);
  assert.equal(stub.sessions.get(`${OV_USER}/${ENGINE_SESSION}`).commitCount, 1);

  // The runtime is released later: the plugin's disposal commit finds nothing pending and archives nothing again.
  await runtime.dispose(session);
  assert.equal(stub.sent("POST", commitPath).length, 2, "the disposal commit is asked");
  assert.equal(stub.sessions.get(`${OV_USER}/${ENGINE_SESSION}`).commitCount, 1, "and the engine extracted the exchange once");
  assert.equal(nativeMemoryCounters().commits.accepted, 1);
});
