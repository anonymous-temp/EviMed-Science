import assert from "node:assert/strict";
import test from "node:test";

import { UNCAPPED_CNY, assertBoundedRunAffordable, boundedRunBudget } from "../src/boundedRunBudget.mjs";
import { learningBudget } from "../src/learningRuntime.mjs";

test("the learning caps count learning spend only; the account caps count everything", async () => {
  // 2026-09-20: the learning caps were compared with everything the account
  // spent, so an account that had spent ¥6.24 on its own research that day had
  // every lesson refused. The two questions are asked separately now.
  const budget = learningBudget({ learningRunLimitCny: 1, learningDailyLimitCny: 5, learningWeeklyLimitCny: 20,
    userDailySpendLimit: 0, userWeeklySpendLimit: 0 });
  assert.deepEqual(budget.own, { dailyLimit: 5, weeklyLimit: 20, purposes: ["learning"] });
  assert.deepEqual(budget.account, { dailyLimit: 0, weeklyLimit: 0 });
  assert.deepEqual(budget.scope, { dailyLimit: UNCAPPED_CNY, weeklyLimit: UNCAPPED_CNY, runLimit: 1 },
    "the gateway's day and week are the account's, not the loop's, so research spend cannot exhaust them");

  /** @type {any[]} */
  const asked = [];
  await assertBoundedRunAffordable({ async assertWithinLimits(userId, limits) { asked.push([userId, limits]); } }, "u1", budget);
  assert.deepEqual(asked, [["u1", budget.own], ["u1", budget.account]]);
});

test("unset or zero caps are no caps, and a signed scope still gets positive numbers", () => {
  for (const config of [{}, { learningRunLimitCny: 0, learningDailyLimitCny: 0, learningWeeklyLimitCny: 0 }]) {
    const budget = learningBudget(config);
    assert.deepEqual(budget.own, { dailyLimit: 0, weeklyLimit: 0, purposes: ["learning"] });
    assert.deepEqual(budget.scope, { dailyLimit: UNCAPPED_CNY, weeklyLimit: UNCAPPED_CNY, runLimit: UNCAPPED_CNY });
    assert.ok(Object.values(budget.scope).every((value) => value > 0), "the bounded runtime refuses a non-positive scope");
  }
});

test("the account's own caps apply to a bounded run as they apply to any run", () => {
  const budget = boundedRunBudget({ purpose: "learning", invalidCode: "learning_budget_invalid" },
    { userDailySpendLimit: 30, userWeeklySpendLimit: 100 });
  assert.deepEqual(budget.account, { dailyLimit: 30, weeklyLimit: 100 });
  assert.deepEqual(budget.scope, { dailyLimit: 30, weeklyLimit: 100, runLimit: UNCAPPED_CNY });
});

test("a nonsense cap is refused by name rather than read as a number", () => {
  for (const value of [-1, NaN, Infinity, "5"]) {
    assert.throws(() => learningBudget({ learningDailyLimitCny: value }), { code: "learning_budget_invalid" });
  }
});
