import { boundedRunBudget } from "./boundedRunBudget.mjs";
import { HttpError } from "./security.mjs";

/**
 * What a scheduled research agenda may spend, and what it has.
 *
 * Hidden knowledge: an agenda's caps were measured against the wrong sum. A
 * task written with ¥3 a day and ¥6 a week was handed, as its daily and weekly
 * limit, to `usageLedger.assertWithinLimits` — which adds up everything the
 * account spent in the window, whatever it was spent on. On 2026-10-04 an
 * account that had spent about ¥16 that day on other research was refused the
 * moment it pressed 立即运行 on a task that had spent nothing, with the
 * account's own wording (HTTP 402 `usage_budget_exceeded`, "This account
 * reached its spending limit"): the more someone used the product, the less
 * their scheduled research could run, and the refusal blamed the account. It is
 * the learning loop's incident of 2026-09-20 over again (`boundedRunBudget.mjs`:
 * "two different questions were being answered by one number"), in the other
 * background worker that carries caps of its own.
 *
 * Two questions, asked separately and never mixed:
 *
 *  - **the task's own caps** (`own`, and `maxEpisodeCny`) count what the task
 *    itself spent: its episodes' planner decisions and runs (booked under the
 *    episode's id) and their verifications (booked under the verification's id,
 *    `episode-<hex>-v<n>`), read from the usage ledger by those run ids
 *    (`UsageLedger.spendOfRuns`). The ledger and not the episode documents,
 *    because it is what the account's own windows are computed from — the same
 *    rows, the same rolling 24 hours and 7 days, the same open-reservation
 *    arithmetic — and what an episode's recorded `costCny` was read from
 *    (`summaryRun` over the same run id), so the two cannot disagree about a
 *    finished episode; it also holds what the documents cannot: the
 *    verifications a merged episode earns later, and a run still in flight.
 *    A decision that stopped the agenda has no episode to be booked under and is
 *    the account's spend only: fractions of a yuan.
 *  - **the account's caps** (`account`, and the signed `scope`'s day and week)
 *    are the researcher's own spending limits, which cover everything. Zero or
 *    unset means none, which is what this deployment ships (`boundedRunBudget`).
 *
 * What is left of the task's own caps (`remainingCny`) is the envelope the next
 * episode, and its planner decision, may spend: an episode is never given more
 * than the task has left, so the cap is a bound on the run and not only a gate
 * before it. A manual run and a follow-up are the researcher asking for work now
 * and are bound by the same budgets; their refusal says which budget it is and
 * that raising it is an edit of the task.
 *
 * @module agendaBudget
 */

/** The least a run can be funded with: a cent, the unit every task budget is written in. */
export const FUNDABLE_CNY = 0.01;

/** The rolling windows, as `usageLedger`'s `openCostWindows` say them. */
export const AGENDA_WINDOW_MS = Object.freeze({ day: 86_400_000, week: 7 * 86_400_000 });

/** Added to a minute bucket's start before a window is added to it, so a freeing time is never early. */
const MINUTE_MS = 60_000;

/** @param {number} value @returns {number} rounded down to a cent: a run is never given more than is left */
const floorCny = (value) => Math.floor(Math.round(value * 1e6) / 1e4) / 100;
/** The ledger's own money scale (`usageLedger`'s `moneyScale`): ¥3 less ¥2.99 is a cent, not 0.009999999999999787. */
const ledgerScale = (/** @type {number} */ value) => Math.round(value * 1e8) / 1e8;

/**
 * The task's caps and the account's, in `boundedRunBudget`'s shape.
 *
 * `own` is the agenda's daily and weekly cap (compared with the agenda's own
 * spend, `agendaAllowance`), `account` is what `assertWithinLimits` is asked
 * about the account, and `scope` is what a bounded runtime and the model
 * gateway are signed with: the account's day and week, and this one run's
 * limit. Never the task's day and week — the gateway sums the account.
 *
 * @param {{ dailyBudgetCny?: unknown, weeklyBudgetCny?: unknown }} payload the agenda's payload
 * @param {Record<string, any>} accountCaps `userDailySpendLimit`, `userWeeklySpendLimit`
 * @param {{ runLimitCny?: number }} [options] the limit of the one run the scope is for
 */
export function agendaBudget(payload, accountCaps, { runLimitCny } = {}) {
  // `boundedRunBudget` reads a zero run limit as "no cap", which is right for a
  // learning step and wrong here: an episode or a verification with nothing left
  // to spend must not become one with no limit.
  if (runLimitCny !== undefined && !(Number.isFinite(runLimitCny) && runLimitCny > 0)) {
    throw new HttpError(400, "autopilot_payload_invalid", "A proactive run needs a positive budget.");
  }
  const shape = boundedRunBudget({
    runLimitCny, dailyLimitCny: /** @type {any} */ (payload.dailyBudgetCny), weeklyLimitCny: /** @type {any} */ (payload.weeklyBudgetCny),
    purpose: "autopilot", invalidCode: "autopilot_budget_invalid",
  }, accountCaps);
  return {
    own: { dailyLimit: shape.own.dailyLimit, weeklyLimit: shape.own.weeklyLimit },
    account: shape.account,
    scope: shape.scope,
  };
}

/**
 * What the task has left of its own caps, given what it spent.
 *
 * `spentWindow` names the window to refuse on when less than a fundable amount
 * is left in one of them — the week first when both are spent, since it frees
 * later and a refusal that named the day would send the researcher back to be
 * refused again by the week. A cap of zero is no cap.
 *
 * @param {{ dailyLimit: number, weeklyLimit: number }} own
 * @param {{ day: number, week: number }} spend
 * @returns {{ day: { limit: number, spent: number, remaining: number }, week: { limit: number, spent: number, remaining: number },
 *   remainingCny: number, spentWindow: "day" | "week" | null }}
 */
export function agendaAllowance(own, spend) {
  const window = (/** @type {number} */ limit, /** @type {number} */ spent) => ({ limit, spent, remaining: limit > 0 ? ledgerScale(limit - spent) : Infinity });
  const day = window(own.dailyLimit, spend.day);
  const week = window(own.weeklyLimit, spend.week);
  const spentWindow = week.remaining < FUNDABLE_CNY ? "week" : day.remaining < FUNDABLE_CNY ? "day" : null;
  return { day, week, remainingCny: Math.max(0, floorCny(Math.min(day.remaining, week.remaining))), spentWindow };
}

/**
 * When a spent window next has room: the moment enough of its oldest spend has
 * aged out for a fundable amount to be left, or null when nothing in the
 * timeline gets it there (the cap itself is smaller than one cent of room).
 * @param {{ timeline: ReadonlyArray<{ at: string, cost: number }>, spent: number, limit: number, windowMs: number, now: number }} input
 *   `timeline` oldest first, as `UsageLedger.spendTimelineOfRuns` returns it
 * @returns {number | null} epoch milliseconds
 */
export function budgetFreesAt({ timeline, spent, limit, windowMs, now }) {
  let held = spent;
  for (const entry of timeline) {
    const leaves = Date.parse(entry.at) + MINUTE_MS + windowMs;
    // Already out of this window: not part of what is held, nothing to wait for.
    if (!Number.isFinite(leaves) || leaves <= now) continue;
    held -= entry.cost;
    if (limit - held >= FUNDABLE_CNY) return leaves;
  }
  return null;
}

const money = (/** @type {number} */ value) => `CNY ${value.toFixed(2)}`;

/**
 * The refusal of a task whose own cap is spent. Its own codes and sentences
 * (`@evimed/domain`'s `autopilot_daily_budget_spent` / `autopilot_weekly_budget_spent`),
 * never `usage_budget_exceeded`'s "this account": the account may have spent
 * nothing at all. 402, like every spending ceiling; `Retry-After` says when
 * the window has room again, when it is known.
 * @param {"day" | "week"} window @param {number} spent @param {number} limit
 * @param {number | null} freesAt epoch milliseconds, or null when unknown @param {number} now
 */
export function taskBudgetRefusal(window, spent, limit, freesAt, now) {
  const daily = window === "day";
  return new HttpError(402, daily ? "autopilot_daily_budget_spent" : "autopilot_weekly_budget_spent",
    `This task's own ${daily ? "daily" : "weekly"} budget is spent: ${money(spent)} of ${money(limit)} in the last ${daily ? "24 hours" : "7 days"}. `
    + "Only this task's own spending counts against it, never the account's other research; raise it by editing the task, or wait for it to free.",
    freesAt === null ? {} : { retryAfterSeconds: Math.max(1, Math.ceil((freesAt - now) / 1000)) });
}
