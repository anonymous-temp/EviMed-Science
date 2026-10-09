/**
 * What a research agenda may be given to spend, and what that buys.
 *
 * A limit on a run compares reservations, so a budget smaller than one model
 * call's reservation can never work: it is refused on its first call. These hold
 * the numbers that make the budgets honest once, in the domain, for the server
 * and the task form to read.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENDA_DEFAULT_BUDGETS,
  AGENDA_MIN_EPISODE_BUDGET_CNY,
  ALL_ERROR_CODES,
  DISPLAY_TIME_ZONE,
  MIN_RUN_BUDGET_CNY,
  STOPPING_RULES,
  VERIFICATION_BUDGET_SHARE,
  VERIFICATION_UNSCHEDULED_REASONS,
  agendaLocalDate,
  knownErrorCodeMessage,
  splitEpisodeBudget,
} from "../index.mjs";

const cents = (/** @type {number} */ value) => Math.round(value * 100);

test("the least a run can be given is above the reservation one model call makes, and the form's defaults are far above it", () => {
  // Measured 2026-10-05: ¥0.52 of output budget plus the prompt at the cache-miss rate is about ¥1.03.
  assert.ok(MIN_RUN_BUDGET_CNY > 1.03, "a run limited to less is refused on its first call");
  assert.ok(MIN_RUN_BUDGET_CNY < 1.5, "and the minimum is not padded: production runs at ¥1.50 are the case that must be valid");
  assert.ok(AGENDA_DEFAULT_BUDGETS.maxEpisodeCny >= AGENDA_MIN_EPISODE_BUDGET_CNY);
  assert.ok(AGENDA_DEFAULT_BUDGETS.maxEpisodeCny <= AGENDA_DEFAULT_BUDGETS.dailyBudgetCny
    && AGENDA_DEFAULT_BUDGETS.dailyBudgetCny <= AGENDA_DEFAULT_BUDGETS.weeklyBudgetCny, "the defaults are in the order the service requires");
});

test("the smallest per-episode cap is the smallest one whose episode share is still a budget a run can be given", () => {
  const share = (/** @type {number} */ cap) => splitEpisodeBudget(cap).episodeCny;
  assert.ok(share(AGENDA_MIN_EPISODE_BUDGET_CNY) >= MIN_RUN_BUDGET_CNY);
  assert.ok(share(AGENDA_MIN_EPISODE_BUDGET_CNY - 0.01) < MIN_RUN_BUDGET_CNY, "a cent less is a cap an episode cannot run on");
  // Every cap from the minimum to a hundred yuan leaves the episode a runnable budget, whatever is held back
  // for re-checks, and the split never spends more than the cap. Whole cents: no float residue decides it.
  let walked = 0;
  for (let cap = cents(AGENDA_MIN_EPISODE_BUDGET_CNY); cap <= 10_000; cap += 1) {
    const split = splitEpisodeBudget(cap / 100);
    const spent = cents(split.episodeCny) + cents(split.verificationCny) * split.verifications;
    assert.ok(split.episodeCny >= MIN_RUN_BUDGET_CNY, `cap ¥${cap / 100}: the episode is left ¥${split.episodeCny}`);
    assert.ok(spent <= cap, `cap ¥${cap / 100}: split spends ¥${spent / 100}`);
    assert.ok(split.verifications === 0 || split.verificationCny >= MIN_RUN_BUDGET_CNY,
      `cap ¥${cap / 100}: a re-check booked at ¥${split.verificationCny} dies on its first call`);
    assert.ok(split.verifications <= STOPPING_RULES.verificationsPerEpisode);
    assert.equal(Number.isInteger(cents(split.episodeCny)) && Number.isInteger(cents(split.verificationCny)), true);
    walked += 1;
  }
  assert.ok(walked > 9_000, "the walk walked");
});

test("the share held back pays for as many re-checks as it can at the minimum a run needs, and none is held that cannot be spent", () => {
  assert.equal(VERIFICATION_BUDGET_SHARE, 0.25);
  const rows = [
    // cap -> [re-checks, each, the episode's own]
    [1.2, 0, 0, 1.2], [1.5, 0, 0, 1.5], [4.79, 0, 0, 4.79], [4.8, 1, 1.2, 3.6], [8, 1, 2, 6], [9.6, 2, 1.2, 7.2],
    [14.39, 2, 1.79, 10.81], [14.4, 3, 1.2, 10.8], [16, 3, 1.33, 12.01], [100, 3, 8.33, 75.01], [500, 3, 41.66, 375.02],
  ];
  for (const [cap, verifications, each, own] of rows) {
    assert.deepEqual(splitEpisodeBudget(cap), { episodeCny: own, verificationCny: each, verifications }, `cap ¥${cap}`);
  }
  // Nothing to split is nothing: never a negative or a NaN that reads as a budget.
  for (const bad of [0, -3, NaN, Infinity, undefined, "x"]) {
    assert.deepEqual(splitEpisodeBudget(/** @type {any} */ (bad)), { episodeCny: 0, verificationCny: 0, verifications: 0 }, String(bad));
  }
});

test("the reasons a claim is not re-checked are a closed list, and the stop's are among them", () => {
  assert.deepEqual([...VERIFICATION_UNSCHEDULED_REASONS].sort(),
    ["agenda_paused", "agenda_stopped", "verification_budget_unavailable", "verification_cap"]);
});

test("the registry says the per-episode minimum in a Chinese sentence, and the cancelled re-check has its own", () => {
  assert.ok(ALL_ERROR_CODES.includes("autopilot_episode_budget_too_small"));
  assert.ok(ALL_ERROR_CODES.includes("verification_canceled_by_stop"));
  const floor = knownErrorCodeMessage("autopilot_episode_budget_too_small") ?? "";
  assert.match(floor, new RegExp(`${AGENDA_MIN_EPISODE_BUDGET_CNY.toFixed(2).replace(".", "\\.")} 灵豆`), "the sentence states the minimum it enforces, in 灵豆");
  const stopped = knownErrorCodeMessage("verification_canceled_by_stop") ?? "";
  assert.match(stopped, /停止/);
  assert.match(stopped, /原结论未被推翻/, "a cancelled re-check is not a finding about the claim");
});

test("a day a person reads is the day in their zone: the UTC day is yesterday for the first eight hours of a day in China", () => {
  assert.equal(DISPLAY_TIME_ZONE, "Asia/Shanghai");
  const late = new Date("2026-10-04T23:30:00Z");
  assert.equal(late.toISOString().slice(0, 10), "2026-10-04", "the UTC day, which is what the sites that were fixed printed");
  assert.equal(agendaLocalDate(DISPLAY_TIME_ZONE, late), "2026-10-05");
  assert.equal(agendaLocalDate("UTC", late), "2026-10-04");
  assert.equal(agendaLocalDate("America/New_York", late), "2026-10-04");
  assert.equal(agendaLocalDate(DISPLAY_TIME_ZONE, "2026-10-04T15:59:59Z"), "2026-10-04", "the boundary is local midnight");
  assert.equal(agendaLocalDate(DISPLAY_TIME_ZONE, "2026-10-04T16:00:00Z"), "2026-10-05");
});
