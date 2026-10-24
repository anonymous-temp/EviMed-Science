// 「重置记忆」 holds against what was in flight (2026-10-23, rectification T1.8 / D7). The reset deletes the account's files and its engine
// sessions and takes the instant; nothing said before that instant is learned from again — however late it reaches the engine: the
// plugin's offline queue replays what it could not post for seven days, each message with the time it was spoken, and a commit armed
// by a turn that ended before the reset must not run after it. The rule is the other engine's (`endedBeforeReset`), applied at the two
// doors the native path has: the gateway's admission and the turn committer.
import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryAdmission } from "../src/memoryAdmission.mjs";
import { nativeMemoryCounters, resetNativeMemoryMetrics } from "../src/nativeMemoryMetrics.mjs";
import { NativeTurnCommit } from "../src/nativeTurnCommit.mjs";

const USER = "user-a";
const SID = "session_0123456789abcdef0123456789abcdef";
const RESET = "2026-10-20T12:00:00.000Z";
const at = (iso) => Date.parse(iso);
const project = { id: "p1", userId: USER };

const memoryDouble = ({ resetAt = RESET, withReset = true } = {}) => ({
  configured: true,
  memoryEngine: async () => "native",
  settings: async () => ({ learningPaused: false, recallPaused: false, pausedProjects: [] }),
  sessionState: async () => ({ trialCapsuleId: null }),
  ...(withReset ? { resetInstant: async () => resetAt } : {}),
});

const admit = (runs, when, researchMemory = memoryDouble()) => createMemoryAdmission({ config: { memoryEnabled: true }, researchMemory,
  conversations: { running: async () => runs.filter((run) => run.status === "running"), runsOf: async () => runs } })
  .admit({ user: { id: USER }, project, engineSessionId: `dsh-${SID}`, at: when });

test("a message spoken before the reset is not learned from, whenever it arrives; one spoken after is", async () => {
  const ledger = [{ id: "r1", sessionId: SID, status: "running", startedAt: "2026-10-20T08:00:00.000Z" }];
  const before = await admit(ledger, at("2026-10-20T09:00:00.000Z"));
  assert.deepEqual([before.learn, before.learnReason, before.native], [false, "before_reset", true]);
  assert.equal(before.recall, true, "reading what is there is not what the reset forbids");
  assert.equal((await admit(ledger, at("2026-10-20T12:00:01.000Z"))).learn, true, "a turn that began before the reset and is still running is the person's now");
  assert.equal((await admit(ledger, at("2026-10-20T12:00:00.000Z"))).learn, true, "the reset's own instant is not before it");
  assert.equal((await admit(ledger, null)).learn, true, "no time on the message and a turn running: the turn decides");
});

test("with no time on the message, a conversation whose last turn was over before the reset is over", async () => {
  const over = [{ id: "r1", sessionId: SID, status: "succeeded", startedAt: "2026-10-20T08:00:00.000Z", finishedAt: "2026-10-20T09:00:00.000Z" }];
  assert.equal((await admit(over, null)).learnReason, "before_reset");
  const after = [{ id: "r2", sessionId: SID, status: "succeeded", startedAt: "2026-10-20T13:00:00.000Z", finishedAt: "2026-10-20T14:00:00.000Z" }, ...over];
  assert.equal((await admit(after, null)).learn, true, "the last turn is after the reset");
  // A turn whose time cannot be read is not placed before anything.
  assert.equal((await admit([{ id: "r3", sessionId: SID, status: "succeeded" }], null)).learn, true);
});

test("an account that never reset, a store that cannot say, and one that fails are not held back", async () => {
  const ledger = [{ id: "r1", sessionId: SID, status: "running", startedAt: "2026-10-20T08:00:00.000Z" }];
  assert.equal((await admit(ledger, at("2026-10-20T09:00:00.000Z"), memoryDouble({ resetAt: null }))).learn, true);
  assert.equal((await admit(ledger, at("2026-10-20T09:00:00.000Z"), memoryDouble({ withReset: false }))).learn, true);
  const failing = { ...memoryDouble(), resetInstant: async () => { throw new Error("database unavailable"); } };
  assert.equal((await admit(ledger, at("2026-10-20T09:00:00.000Z"), failing)).learn, true, "a reset that cannot be read stops no conversation from being learned from");
});

function committer({ resetAt = RESET, researchMemory = null } = {}) {
  resetNativeMemoryMetrics();
  /** @type {Set<{ fn: () => void }>} */ const timers = new Set();
  const commits = [];
  const instance = new NativeTurnCommit({
    config: { ovNativeMemoryEnabled: true, memoryEnabled: true, nativeMemoryTurnCommitDebounceMs: 8_000, nativeMemoryTurnCommitSettleMs: 0, nativeMemoryTurnCommitAttempts: 2 },
    researchMemory: researchMemory ?? memoryDouble({ resetAt }), sessions: { configured: true, readSession: async () => ({ result: { pending_tokens: 100, message_count: 2 } }) },
    admission: { admit: async () => ({ native: true, learn: true, recall: true, learnReason: null, recallReason: null, sessionId: SID }) },
    conversations: { runsOf: async () => [] },
    commit: async (request) => { commits.push(request); return { commit: "accepted" }; },
    setTimer: (fn) => { const timer = { fn }; timers.add(timer); return timer; }, clearTimer: (timer) => timers.delete(timer), wait: async () => {},
  });
  return { instance, commits, fire: () => { for (const timer of [...timers]) { timers.delete(timer); timer.fn(); } } };
}

test("a commit armed by a turn that ended before the reset does not run after it; a turn that ended after does", async () => {
  const old = committer();
  await old.instance.noteRunFinished(project, { id: "run-1", sessionId: SID, status: "succeeded", finishedAt: "2026-10-20T11:59:00.000Z" });
  old.fire();
  await old.instance.idle();
  assert.deepEqual(old.commits, []);
  assert.equal(nativeMemoryCounters().turnCommits.before_reset, 1);
  assert.equal(nativeMemoryCounters().turnCommits.committed, 0);

  const fresh = committer();
  await fresh.instance.noteRunFinished(project, { id: "run-2", sessionId: SID, status: "succeeded", finishedAt: "2026-10-20T12:05:00.000Z" });
  fresh.fire();
  await fresh.instance.idle();
  assert.equal(fresh.commits.length, 1);
  assert.equal(nativeMemoryCounters().turnCommits.committed, 1);

  // No reset, no instant to read, a run with no time: committed as before.
  for (const options of [{ resetAt: null }, { researchMemory: memoryDouble({ withReset: false }) }]) {
    const plain = committer(options);
    await plain.instance.noteRunFinished(project, { id: "run-3", sessionId: SID, status: "succeeded", finishedAt: "2026-10-20T11:59:00.000Z" });
    plain.fire();
    await plain.instance.idle();
    assert.equal(plain.commits.length, 1, JSON.stringify(options));
  }
  const untimed = committer();
  await untimed.instance.noteRunFinished(project, { id: "run-4", sessionId: SID, status: "succeeded" });
  untimed.fire();
  await untimed.instance.idle();
  assert.equal(untimed.commits.length, 1, "a run whose time cannot be read is not placed before anything");
});
