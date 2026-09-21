import { HttpError } from "./security.mjs";

/**
 * What a bounded run — a learning step, a source being understood — may spend.
 *
 * Hidden knowledge: two different questions were being answered by one number.
 * A bounded run's caps (learning: ¥1 a run, ¥5 a day, ¥20 a week) were passed
 * to `assertWithinLimits`, which sums everything the account spent, and to the
 * model gateway, whose per-request reservation does the same. So the learning
 * budget was measured against the researcher's own research: on 2026-09-20 an
 * account that had spent ¥6.24 on its own runs that day had every lesson from
 * those runs refused, and production held zero learned methods. The more
 * someone used the product, the less it could learn from them.
 *
 * Now the two questions are separate:
 *
 *  - **this kind of work's own caps** (`own`) count only its own purpose in the
 *    usage ledger (`learning`, `source-understanding`);
 *  - **the account's caps** (`account`, and the gateway `scope`) are the
 *    researcher's own spend limits, which cover everything, bounded runs
 *    included, exactly as they cover an interactive run.
 *
 * Zero (or unset) means no cap, which is the default for all of them since the
 * owner's ruling of 2026-09-21: nothing is to stop the product from being
 * exercised while it is being tested. The gateway and the bounded runtime need
 * positive numbers in their signed scope, so "no cap" crosses that boundary as
 * `UNCAPPED_CNY`, a figure no run reaches.
 *
 * @module boundedRunBudget
 */

/** What "no cap" becomes where a signed scope needs a positive number. */
export const UNCAPPED_CNY = 1_000_000;

/** @param {unknown} value @param {string} code @returns {number} 0 for no cap */
function cap(value, code) {
  if (value == null || value === "") return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new HttpError(503, code, "A spending cap must be zero (no cap) or a finite positive CNY amount.");
  }
  return value;
}

/**
 * @param {{ runLimitCny?: number, dailyLimitCny?: number, weeklyLimitCny?: number,
 *   purpose: "learning" | "source-understanding", invalidCode: string }} own
 * @param {Record<string, any>} config the account caps: `userDailySpendLimit`, `userWeeklySpendLimit`
 */
export function boundedRunBudget(own, config) {
  const run = cap(own.runLimitCny, own.invalidCode);
  const daily = cap(own.dailyLimitCny, own.invalidCode);
  const weekly = cap(own.weeklyLimitCny, own.invalidCode);
  const accountDaily = cap(config.userDailySpendLimit, own.invalidCode);
  const accountWeekly = cap(config.userWeeklySpendLimit, own.invalidCode);
  return {
    /** Checked before the run starts: this kind of work against its own caps. */
    own: { dailyLimit: daily, weeklyLimit: weekly, purposes: [own.purpose] },
    /** Checked before the run starts: the account's caps, over everything. */
    account: { dailyLimit: accountDaily, weeklyLimit: accountWeekly },
    /** Signed into the bounded runtime and every model request it makes. */
    scope: {
      dailyLimit: accountDaily || UNCAPPED_CNY,
      weeklyLimit: accountWeekly || UNCAPPED_CNY,
      runLimit: run || UNCAPPED_CNY,
    },
  };
}

/**
 * Both pre-flight questions, in the order a refusal is most useful to read.
 * @param {{ assertWithinLimits: (userId: string, limits: any) => Promise<any> }} usageLedger
 * @param {string} userId @param {ReturnType<typeof boundedRunBudget>} budget
 */
export async function assertBoundedRunAffordable(usageLedger, userId, budget) {
  await usageLedger.assertWithinLimits(userId, budget.own);
  await usageLedger.assertWithinLimits(userId, budget.account);
}
