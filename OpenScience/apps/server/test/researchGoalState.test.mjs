import assert from "node:assert/strict";
import test from "node:test";
import { goalBarState, goalRounds, goalSpendCny, guardVerdict, isGoalContinuation, roundProducedFiles, roundWasInterrupted, roundsWithoutProgress, setsResearchGoal, statusFromGoalBar } from "../src/researchGoalState.mjs";

const at = (minute) => new Date(Date.UTC(2026, 10, 3, 10, minute)).toISOString();
const setting = (over = {}) => ({ id: "r0", sessionId: "s", effectiveRouteReason: "research-goal", question: "评估", status: "succeeded", startedAt: at(0), artifacts: ["report.md"], usage: { costCny: 1 }, ...over });
const round = (minute, over = {}) => ({ id: `r${minute}`, sessionId: "s", automated: true, effectiveRouteReason: "adopted:runtime-ui:loopx-continuation", status: "succeeded", startedAt: at(minute), artifacts: [], usage: { costCny: 0.1 }, ...over });

test("a goal's rounds begin at the turn that set it, and an ordinary earlier turn of the session is not one", () => {
  const before = { id: "a", sessionId: "s", effectiveRouteReason: "unrouted:open-domain", question: "你好", status: "succeeded", startedAt: at(0) };
  const first = setting({ startedAt: at(1) });
  const next = round(2);
  const other = round(3, { sessionId: "elsewhere" });
  assert.deepEqual(goalRounds([next, other, before, first], "s").map((run) => run.id), [first.id, next.id]);
  assert.deepEqual(goalRounds([before], "s"), []);
});

test("the turn that set a goal: the page's route, or the gesture typed in a conversation; never an automated turn", () => {
  assert.equal(setsResearchGoal(setting()), true);
  assert.equal(setsResearchGoal({ question: "/loopx 评估", effectiveRouteReason: "unrouted:open-domain" }), true);
  assert.equal(setsResearchGoal({ question: "/loopx 评估", automated: true }), false);
  assert.equal(setsResearchGoal({ question: "讲讲 /loopx" }), false);
  assert.equal(isGoalContinuation(round(1)), true);
  assert.equal(isGoalContinuation(round(1, { automated: false })), false);
});

test("rounds without progress count back to the last round that left a file", () => {
  const rounds = [setting(), round(1, { artifacts: ["a.md"] }), round(2), round(3), round(4)];
  assert.equal(roundsWithoutProgress(rounds), 3);
  assert.equal(roundsWithoutProgress([...rounds, round(5, { outputFiles: ["b.md"] })]), 0);
  assert.equal(roundProducedFiles(round(9, { presentedFiles: ["c.md"] })), true);
});

test("a running round neither ends nor adds to the count, and a person's turn ends it", () => {
  assert.equal(roundsWithoutProgress([round(1), round(2), round(3, { status: "running" })]), 2);
  assert.equal(roundsWithoutProgress([round(1), { id: "p", sessionId: "s", status: "succeeded", startedAt: at(2), artifacts: [] }, round(3)]), 1);
});

test("the count and the spend start again from when a person took the goal up", () => {
  const rounds = [setting(), round(1), round(2), round(3), round(4)];
  assert.equal(roundsWithoutProgress(rounds, at(3)), 2);
  assert.ok(Math.abs(goalSpendCny(rounds) - 1.4) < 1e-9);
  assert.ok(Math.abs(goalSpendCny(rounds, at(3)) - 0.2) < 1e-9);
});

test("the guard: the spend limit first, then rounds without progress, and a limit of 0 is off", () => {
  const rounds = [setting({ usage: { costCny: 60 } }), round(1), round(2), round(3)];
  assert.equal(guardVerdict({ rounds, maxRoundsWithoutProgress: 3, maxCny: 50 }), "budget");
  assert.equal(guardVerdict({ rounds, maxRoundsWithoutProgress: 3, maxCny: 0 }), "no_progress");
  assert.equal(guardVerdict({ rounds, maxRoundsWithoutProgress: 0, maxCny: 0 }), null);
  assert.equal(guardVerdict({ rounds: [setting(), round(1), round(2)], maxRoundsWithoutProgress: 3, maxCny: 50 }), null);
});

test("the alternation of a real topic does not trip the guard", () => {
  // Rounds of the SGLT2 goal of 2026-11-03: 3, 0, 1, 1, 2, 0, 3, 0, 2, 2 files.
  const counts = [0, 1, 1, 2, 0, 3, 0, 2, 2];
  const rounds = [setting(), ...counts.map((files, index) => round(index + 1, { artifacts: Array.from({ length: files }, (_, n) => `${n}.md`) }))];
  for (let end = 1; end <= rounds.length; end += 1) {
    assert.equal(guardVerdict({ rounds: rounds.slice(0, end), maxRoundsWithoutProgress: 3, maxCny: 50 }), null);
  }
});

test("a goal that keeps going after its work is done trips it on its third empty round", () => {
  const worked = [setting(), round(1, { artifacts: ["n.md"] }), round(2, { artifacts: ["summary.md"] })];
  assert.equal(guardVerdict({ rounds: [...worked, round(3), round(4)], maxRoundsWithoutProgress: 3, maxCny: 50 }), null);
  assert.equal(guardVerdict({ rounds: [...worked, round(3), round(4), round(5)], maxRoundsWithoutProgress: 3, maxCny: 50 }), "no_progress");
});

test("interrupted: the platform or the provider ended the round; a person's stop and a spent balance are not", () => {
  assert.equal(roundWasInterrupted(round(1, { status: "failed", errorCode: "runtime_stopped" })), true);
  assert.equal(roundWasInterrupted(round(1, { status: "canceled", errorCode: "runtime_canceled", canceledBy: "platform" })), true);
  assert.equal(roundWasInterrupted(round(1, { status: "canceled", errorCode: "runtime_canceled" })), true);
  assert.equal(roundWasInterrupted(round(1, { status: "failed", errorCode: "model_empty_reply" })), true);
  assert.equal(roundWasInterrupted(round(1, { status: "canceled", errorCode: "runtime_canceled", canceledBy: "user" })), false);
  assert.equal(roundWasInterrupted(round(1, { status: "failed", errorCode: "runtime_spend_limit_reached" })), false);
  assert.equal(roundWasInterrupted(round(1)), false);
  assert.equal(roundWasInterrupted(round(1, { status: "running" })), false);
});

test("what LoopX's bar says becomes a state: all work done, stopped, no goal, or work left", () => {
  const present = (activation, remaining, total = 5) => ({ result: { kind: "present", snapshot: { goalId: "g", loopxAgentId: "a", goalActivation: activation, progress: { processed: total - remaining, remaining, total } } } });
  assert.deepEqual(statusFromGoalBar(goalBarState(present("active", 0))), { status: "finished" });
  assert.deepEqual(statusFromGoalBar(goalBarState(present("active", 2))), { status: "waiting" });
  assert.deepEqual(statusFromGoalBar(goalBarState(present("stopped", 2))), { status: "paused", reason: "person" });
  assert.deepEqual(statusFromGoalBar(goalBarState(present("active", 0, 0))), { status: "waiting" });
  assert.deepEqual(statusFromGoalBar(goalBarState({ result: { kind: "hidden", reason: "binding_missing" } })), { status: "finished" });
  assert.equal(statusFromGoalBar(goalBarState({ result: { kind: "fault", code: "session_unavailable" } })), null);
  assert.equal(statusFromGoalBar(goalBarState(null)), null);
  assert.equal(goalBarState({ result: { kind: "fault", code: "session_unavailable" } }).code, "session_unavailable");
});
