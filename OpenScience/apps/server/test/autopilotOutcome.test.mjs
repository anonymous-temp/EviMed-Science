import assert from "node:assert/strict";
import test from "node:test";
import { STOPPING_RULES } from "@evimed/domain";
import { foldOutcome, reducedPriority } from "../src/autopilotOutcome.mjs";
import { eligibleTaskTypes } from "../src/autopilotNextAction.mjs";

const AT = "2026-10-04T01:00:00.000Z";
const agenda = (extra = {}) => ({ enabled: true, status: "active", pauseReason: null, taskTypes: ["literature-sentinel", "evidence-update"],
  consecutiveFailures: 0, episodesWithoutGatedClaim: 0, outcomes: [], ...extra });
let sequence = 0;
/** Fold one outcome of one task type into the payload, the way recordOutcome merges it. */
function record(payload, taskType, status, gatedClaims = 0, extra = {}) {
  sequence += 1;
  return { ...payload, ...foldOutcome(payload, { episodeId: `episode-${sequence}`, taskType, status, gatedClaims,
    daysSinceDigestOpened: 0, userRejected: false, at: AT, ...extra }) };
}

test("a task type that keeps failing to run is paused alone and the agenda goes on with the others", () => {
  let payload = agenda();
  payload = record(payload, "literature-sentinel", "failed");
  assert.equal(payload.status, "active", "one failure pauses nothing");
  payload = record(payload, "literature-sentinel", "failed");
  assert.equal(payload.status, "active", "the other type has done nothing wrong");
  assert.equal(payload.enabled, true);
  assert.equal(payload.pauseReason, null);
  assert.ok(payload.taskTypeState["literature-sentinel"].pausedAt);
  assert.match(payload.taskTypeState["literature-sentinel"].pauseReason, /连续失败/);
  assert.deepEqual(eligibleTaskTypes(payload), ["evidence-update"]);
});

test("another type's success does not erase a type's failures, which is what one agenda-wide counter did", () => {
  let payload = agenda();
  payload = record(payload, "literature-sentinel", "failed");
  payload = record(payload, "evidence-update", "succeeded", 1);
  payload = record(payload, "literature-sentinel", "failed");
  assert.deepEqual(eligibleTaskTypes(payload), ["evidence-update"]);
  assert.equal(payload.status, "active");
});

test("a type's own success resets its failures", () => {
  let payload = agenda();
  payload = record(payload, "literature-sentinel", "failed");
  payload = record(payload, "literature-sentinel", "succeeded", 1);
  payload = record(payload, "literature-sentinel", "failed");
  assert.equal(payload.taskTypeState["literature-sentinel"].consecutiveFailures, 1);
  assert.deepEqual(eligibleTaskTypes(payload), ["literature-sentinel", "evidence-update"]);
});

test("an agenda with one task type is paused when it is the one that failed, as before", () => {
  let payload = agenda({ taskTypes: ["evidence-update"] });
  payload = record(payload, "evidence-update", "failed");
  payload = record(payload, "evidence-update", "failed");
  assert.equal(payload.status, "paused");
  assert.equal(payload.enabled, false);
  assert.match(payload.pauseReason, /连续失败/);
});

test("an agenda whose every type is paused has nothing it may run and is paused", () => {
  let payload = agenda();
  for (const type of ["literature-sentinel", "evidence-update"]) {
    payload = record(payload, type, "failed");
    payload = record(payload, type, "failed");
  }
  assert.deepEqual(eligibleTaskTypes(payload), []);
  assert.equal(payload.status, "paused");
  assert.equal(payload.enabled, false);
});

test("a researcher's stopped agenda stays stopped whatever an outcome says", () => {
  const payload = record(agenda({ status: "stopped", enabled: false, taskTypes: ["evidence-update"] }), "evidence-update", "failed");
  assert.equal(payload.status, "stopped");
});

test("an execution failure is never an episode without a result: only a succeeded episode moves the yield count", () => {
  let payload = agenda({ episodesWithoutGatedClaim: 2 });
  for (const status of ["failed", "canceled", "failed", "canceled"]) payload = record(payload, null, status);
  assert.equal(payload.episodesWithoutGatedClaim, 2, "four episodes that never looked at the question changed nothing");
  assert.equal(reducedPriority(payload), false);
  payload = record(payload, "evidence-update", "succeeded", 0);
  assert.equal(payload.episodesWithoutGatedClaim, 3);
  assert.equal(reducedPriority(payload), true, "three episodes that ran and found nothing halve the direction");
  payload = record(payload, "evidence-update", "succeeded", 2);
  assert.equal(payload.episodesWithoutGatedClaim, 0);
  assert.equal(reducedPriority(payload), false, "a gated claim restores it, because nothing is stored");
});

test("a canceled episode leaves every count where it was", () => {
  let payload = agenda({ consecutiveFailures: 1, taskTypeState: { "evidence-update": { consecutiveFailures: 1 } } });
  payload = record(payload, "evidence-update", "canceled");
  assert.equal(payload.consecutiveFailures, 1);
  assert.equal(payload.taskTypeState["evidence-update"].consecutiveFailures, 1);
  assert.equal(payload.outcomes.at(-1).status, "canceled");
});

test("reduced priority is the domain's halve, and a parked direction that is restarted stays reduced", () => {
  const halving = STOPPING_RULES.episodesWithoutGatedClaimBeforeHalving;
  const parking = STOPPING_RULES.episodesWithoutGatedClaimBeforeParking;
  assert.equal(reducedPriority(agenda({ episodesWithoutGatedClaim: halving - 1 })), false);
  assert.equal(reducedPriority(agenda({ episodesWithoutGatedClaim: halving })), true);
  assert.equal(reducedPriority(agenda({ episodesWithoutGatedClaim: parking })), true);
  assert.equal(reducedPriority({}), false);
  // Reaching the parking count pauses the thread, as it always did.
  let payload = agenda({ episodesWithoutGatedClaim: parking - 1 });
  payload = record(payload, "evidence-update", "succeeded", 0);
  assert.equal(payload.status, "paused");
  assert.match(payload.pauseReason, /没有产出可用结论/);
});

test("an unread thread and a rejected direction pause the whole agenda, whatever the type", () => {
  const unread = record(agenda(), "evidence-update", "succeeded", 1, { daysSinceDigestOpened: STOPPING_RULES.daysWithoutOpeningDigestBeforePausing });
  assert.equal(unread.status, "paused");
  const rejected = record(agenda(), "evidence-update", "succeeded", 1, { userRejected: true });
  assert.equal(rejected.status, "paused");
  assert.match(rejected.pauseReason, /驳回/);
});

test("an episode the ledger cannot name leaves the types alone, and each outcome records its type", () => {
  const unnamed = record(agenda(), null, "failed");
  assert.deepEqual(unnamed.taskTypeState, {});
  assert.equal(unnamed.consecutiveFailures, 1, "the agenda-wide count still moves");
  const named = record(agenda(), "evidence-update", "succeeded", 1);
  assert.equal(named.outcomes.at(-1).taskType, "evidence-update");
  const unknown = record(agenda(), "not-a-task-type", "failed");
  assert.deepEqual(unknown.taskTypeState, {}, "only the closed vocabulary keeps a state");
});

test("the outcome list stays bounded", () => {
  let payload = agenda({ outcomes: Array.from({ length: 100 }, (_, index) => ({ episodeId: `old-${index}`, status: "succeeded", gatedClaims: 1, at: AT })) });
  payload = record(payload, "evidence-update", "succeeded", 1);
  assert.equal(payload.outcomes.length, 100);
  assert.equal(payload.outcomes[0].episodeId, "old-1");
});
