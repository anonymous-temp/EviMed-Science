import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { UNCAPPED_CNY } from "../src/boundedRunBudget.mjs";
import { MIN_RUN_BUDGET_CNY } from "@evimed/domain";
import { AGENDA_WINDOW_MS, FUNDABLE_CNY, agendaAllowance, agendaBudget, budgetFreesAt, taskBudgetRefusal } from "../src/agendaBudget.mjs";
import { agendaRunIds, verificationIdFor } from "../src/autopilotService.mjs";
import { openCostWindows } from "../src/usageLedger.mjs";

const payload = { dailyBudgetCny: 3, weeklyBudgetCny: 6, maxEpisodeCny: 1.5 };

test("the task's caps and the account's are two questions, and the signed scope carries only the account's day and week", () => {
  // 2026-10-04: the task's ¥3 a day was handed to a check that sums the account's whole spend.
  const budget = agendaBudget(payload, { userDailySpendLimit: 0, userWeeklySpendLimit: 0 }, { runLimitCny: 1.12 });
  assert.deepEqual(budget.own, { dailyLimit: 3, weeklyLimit: 6 });
  assert.deepEqual(budget.account, { dailyLimit: 0, weeklyLimit: 0 });
  assert.deepEqual(budget.scope, { dailyLimit: UNCAPPED_CNY, weeklyLimit: UNCAPPED_CNY, runLimit: 1.12 });

  const capped = agendaBudget(payload, { userDailySpendLimit: 30, userWeeklySpendLimit: 100 }, { runLimitCny: 1.12 });
  assert.deepEqual(capped.account, { dailyLimit: 30, weeklyLimit: 100 });
  assert.deepEqual(capped.scope, { dailyLimit: 30, weeklyLimit: 100, runLimit: 1.12 }, "the account's own caps ride in the scope, the task's never");
  assert.equal(Object.values(capped.scope).includes(3), false);
});

test("the task's windows are the ledger's windows: one clock for the account's caps and the task's", () => {
  // `spendOfRuns` measures in SQL with `openCostWindows`; the freeing time is computed here with these.
  const hours = (/** @type {string} */ text) => { const [count, unit] = text.split(" "); return Number(count) * (unit.startsWith("hour") ? 3_600_000 : 86_400_000); };
  assert.equal(AGENDA_WINDOW_MS.day, hours(openCostWindows.day));
  assert.equal(AGENDA_WINDOW_MS.week, hours(openCostWindows.week));
});

test("a run with nothing to spend is refused, not read as a run with no limit", () => {
  for (const runLimitCny of [0, -1, NaN, Infinity]) {
    assert.throws(() => agendaBudget(payload, {}, { runLimitCny }), { code: "autopilot_payload_invalid" }, String(runLimitCny));
  }
  assert.doesNotThrow(() => agendaBudget(payload, {}), "a budget asked about with no run in mind is only the caps");
});

test("what is left of the task's own caps, in the window that binds, named weekly first when both are spent", () => {
  const own = { dailyLimit: 3, weeklyLimit: 6 };
  assert.deepEqual(agendaAllowance(own, { day: 0, week: 0 }), {
    day: { limit: 3, spent: 0, remaining: 3 }, week: { limit: 6, spent: 0, remaining: 6 }, remainingCny: 3, spentWindow: null });
  // ¥16 spent by the account on other research is not in these numbers: only the task's own are asked.
  assert.equal(agendaAllowance(own, { day: 1.6, week: 1.6 }).remainingCny, 1.4);
  assert.equal(agendaAllowance(own, { day: 0.5, week: 4.6 }).remainingCny, 1.4, "the week binds when it is tighter");
  assert.equal(agendaAllowance(own, { day: 0.5, week: 4.6 }).spentWindow, null);
  assert.equal(agendaAllowance(own, { day: 3, week: 3 }).spentWindow, "day");
  assert.equal(agendaAllowance(own, { day: 1, week: 6 }).spentWindow, "week");
  assert.equal(agendaAllowance(own, { day: 3, week: 6 }).spentWindow, "week", "both spent: the one that frees later, or the day's wait ends in a second refusal");
  // Less than a run needs funds nothing: a model call reserves about ¥1 before it is sent, so a run given
  // ¥0.40 or ¥1.10 is refused on its first call. The refusal comes before a run with no room to make one.
  assert.equal(FUNDABLE_CNY, MIN_RUN_BUDGET_CNY);
  assert.equal(agendaAllowance(own, { day: 2.6, week: 2.6 }).spentWindow, "day", "¥0.40 left is not a budget");
  assert.equal(agendaAllowance(own, { day: 1.85, week: 1.85 }).spentWindow, "day", "¥1.15 left is not a budget either");
  assert.equal(agendaAllowance(own, { day: 1.8, week: 1.8 }).spentWindow, null, "¥1.20 is exactly what one run needs");
  assert.equal(agendaAllowance(own, { day: 1.81, week: 1.81 }).spentWindow, "day");
  assert.equal(agendaAllowance(own, { day: 1.8, week: 1.8 }).remainingCny, FUNDABLE_CNY, "rounded down to the cent, never up");
  assert.equal(agendaAllowance(own, { day: 1.79, week: 1.79 }).remainingCny, 1.21);
  assert.equal(agendaAllowance(own, { day: 9, week: 9 }).remainingCny, 0, "an overdrawn window has nothing left, not less than nothing");
  // A cap of zero is no cap.
  assert.deepEqual(agendaAllowance({ dailyLimit: 0, weeklyLimit: 0 }, { day: 99, week: 99 }).spentWindow, null);
  assert.equal(agendaAllowance({ dailyLimit: 0, weeklyLimit: 0 }, { day: 99, week: 99 }).remainingCny, Infinity);
});

test("a spent window frees when enough of its oldest spend has aged out, never before", () => {
  const now = Date.parse("2026-10-04T12:00:00Z");
  const minute = 60_000;
  // ¥3 of a ¥3 day: ¥2 at 06:00 and ¥1 at 09:00. The ¥2 leaving frees room; the ¥1 alone does too.
  const timeline = [{ at: "2026-10-04T06:00:00.000Z", cost: 2 }, { at: "2026-10-04T09:00:00.000Z", cost: 1 }];
  const freed = budgetFreesAt({ timeline, spent: 3, limit: 3, windowMs: AGENDA_WINDOW_MS.day, now });
  assert.equal(freed, Date.parse("2026-10-05T06:00:00Z") + minute, "the bucket's minute is added: an early promise sends the researcher back to be refused again");
  // Spend that already left the window is not waited for.
  const aged = [{ at: "2026-10-03T06:00:00.000Z", cost: 5 }, ...timeline];
  assert.equal(budgetFreesAt({ timeline: aged, spent: 3, limit: 3, windowMs: AGENDA_WINDOW_MS.day, now }), freed);
  // It takes both entries when one is not enough: ¥1.9 spent of ¥3 leaves ¥1.10 — less than a run needs — so the
  // spend that frees a fundable ¥1.20 is waited for; ¥3 held by two halves needs the first only.
  const barely = [{ at: "2026-10-04T06:00:00.000Z", cost: 0.2 }, { at: "2026-10-04T07:00:00.000Z", cost: 1.7 }];
  assert.equal(budgetFreesAt({ timeline: barely, spent: 1.9, limit: 3, windowMs: AGENDA_WINDOW_MS.day, now }), Date.parse("2026-10-05T06:00:00Z") + minute,
    "the first entry leaving leaves ¥1.30 of room, which is already a run: no wait for the second");
  const halves = [{ at: "2026-10-04T06:00:00.000Z", cost: 0.5 }, { at: "2026-10-04T07:00:00.000Z", cost: 2.5 }];
  assert.equal(budgetFreesAt({ timeline: halves, spent: 3, limit: 3, windowMs: AGENDA_WINDOW_MS.day, now }), Date.parse("2026-10-05T07:00:00Z") + minute,
    "¥0.50 leaving is not enough room for a run; it takes the ¥2.50 as well");
  // Nothing in the timeline gets it there: unknown, not invented.
  assert.equal(budgetFreesAt({ timeline: [], spent: 3, limit: 3, windowMs: AGENDA_WINDOW_MS.day, now }), null);
  assert.equal(budgetFreesAt({ timeline: [{ at: "garbage", cost: 3 }], spent: 3, limit: 3, windowMs: AGENDA_WINDOW_MS.day, now }), null);
});

test("the refusal is the task's, in the task's words, with a time only when one is known", () => {
  const now = Date.parse("2026-10-04T12:00:00Z");
  const daily = taskBudgetRefusal("day", 3, 3, now + 3 * 3_600_000 + 500, now);
  assert.deepEqual([daily.status, daily.code, daily.retryAfterSeconds], [402, "autopilot_daily_budget_spent", 3 * 3600 + 1]);
  assert.match(daily.message, /This task's own daily budget is spent: CNY 3\.00 of CNY 3\.00 in the last 24 hours/);
  assert.doesNotMatch(daily.message, /account reached|usage_budget_exceeded/i, "the account is not the subject");
  const weekly = taskBudgetRefusal("week", 6, 6, null, now);
  assert.deepEqual([weekly.status, weekly.code, weekly.retryAfterSeconds], [402, "autopilot_weekly_budget_spent", undefined]);
  assert.match(weekly.message, /weekly budget is spent.*in the last 7 days/);
  assert.equal(taskBudgetRefusal("day", 3, 3, now - 5_000, now).retryAfterSeconds, 1, "never zero or negative");
});

test("an agenda's runs are its episodes' ids and the verifications each may earn", () => {
  const ids = agendaRunIds(["episode-aaaa", "episode-bbbb"]);
  assert.deepEqual(ids, ["episode-aaaa", verificationIdFor("episode-aaaa", 0), verificationIdFor("episode-aaaa", 1), verificationIdFor("episode-aaaa", 2),
    "episode-bbbb", verificationIdFor("episode-bbbb", 0), verificationIdFor("episode-bbbb", 1), verificationIdFor("episode-bbbb", 2)]);
  assert.deepEqual(agendaRunIds([]), []);
});

// ---------------------------------------------------------------------------
// The walk: every place in the control plane that reads an agenda's own budget.
//
// The incident was one line (`assertWithinLimits(userId, { dailyLimit: agenda.payload.dailyBudgetCny ... })`)
// and its sibling were four: the scheduling check, the planner's limits, the
// episode's signed scope and the verification's. This walks the source for the
// fields and holds that the agenda's own daily and weekly caps are read in
// exactly the places that compare them with the agenda's own spend, and
// nowhere that hands them to something that sums the account's.
// ---------------------------------------------------------------------------

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

/** @param {string} dir @returns {string[]} */
function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? sources(path.join(dir, entry.name))
    : entry.name.endsWith(".mjs") ? [path.join(dir, entry.name)] : []);
}

/** @param {RegExp} field @returns {Array<{ file: string, line: number, text: string }>} */
function mentions(field) {
  return sources(SRC).flatMap((file) => readFileSync(file, "utf8").split("\n")
    .map((text, index) => ({ file: path.relative(SRC, file), line: index + 1, text }))
    .filter(({ text }) => field.test(text) && !/^\s*(\/\/|\*|\/\*)/.test(text)));
}

test("an agenda's daily and weekly caps are read only where they meet the agenda's own spend", () => {
  const found = mentions(/\b(?:dailyBudgetCny|weeklyBudgetCny)\b/);
  // The walk must have walked: the validation, the edit allowlist, the commit's field list, the
  // envelope and the budget builder are all in the service and the builder, and the routes' body lists.
  assert.ok(found.length >= 10, `the walk found only ${found.length} mentions`);
  const files = [...new Set(found.map((item) => item.file))].sort();
  // `evidenceProgramme.mjs` (2026-10-05) is added on purpose: it WRITES the caps of the platform's own agendas from the programme's budget
  // (`agendaCaps`, `ensureAgenda`) and compares them with nothing; the comparison stays `AutopilotService.assertAffordable`'s.
  assert.deepEqual(files, ["agendaBudget.mjs", "autopilotRoutes.mjs", "autopilotService.mjs", "evidenceProgramme.mjs"],
    "a new reader of an agenda's caps is a new place to compare them with the wrong sum: add it to this walk on purpose");
  // And in none of them is a cap on the same line as a call that sums the account (the ledger's admission, a gateway limit).
  for (const { file, line, text } of found) {
    assert.doesNotMatch(text, /assertWithinLimits|\blimits\s*:|\bdailyLimit\s*:|\bweeklyLimit\s*:|minimumPositive/,
      `${file}:${line} hands an agenda's cap to something that sums the account's spend: ${text.trim()}`);
  }
  // The one place that turns them into limits names them for what they are: the agenda's own caps of the budget builder,
  // which `AutopilotService.assertAffordable` compares with `UsageLedger.spendOfRuns`, never with `assertWithinLimits`.
  const builder = found.filter((item) => item.file === "agendaBudget.mjs");
  assert.ok(builder.length >= 1 && builder.every((item) => /dailyLimitCny|weeklyLimitCny/.test(item.text)));
});

test("the episode cap is an envelope for one episode, read where an episode is funded and nowhere that sums a window", () => {
  const found = mentions(/\bmaxEpisodeCny\b/);
  assert.ok(found.length >= 6, `the walk found only ${found.length} mentions`);
  // The programme sets its agendas' episode cap from `OPEN_SCIENCE_EVIDENCE_PROGRAMME_EPISODE_BUDGET_CNY` and reads it nowhere else.
  assert.deepEqual([...new Set(found.map((item) => item.file))].sort(), ["autopilotRoutes.mjs", "autopilotService.mjs", "evidenceProgramme.mjs"]);
  for (const { file, line, text } of found) assert.doesNotMatch(text, /assertWithinLimits|\blimits\s*:|minimumPositive/, `${file}:${line}: ${text.trim()}`);
});

test("the floors are read where a budget becomes a run's limit, and the server restates neither number", () => {
  // `MIN_RUN_BUDGET_CNY` is what a run needs and `AGENDA_MIN_EPISODE_BUDGET_CNY` what an episode cap is held to; both are the
  // domain's. A third reader is a third place a budget can be given to a run that cannot make its first call.
  const floor = mentions(/\bAGENDA_MIN_EPISODE_BUDGET_CNY\b/);
  assert.ok(floor.length >= 6, `the walk found only ${floor.length} mentions`);
  assert.deepEqual([...new Set(floor.map((item) => item.file))].sort(), ["autopilotService.mjs"],
    "the cap is held to the floor where it is set (create, update), started and scheduled, and nowhere that sums a window");
  const run = mentions(/\bMIN_RUN_BUDGET_CNY\b/);
  assert.deepEqual([...new Set(run.map((item) => item.file))].sort(), ["agendaBudget.mjs", "autopilotService.mjs"],
    "what is left of a window (`FUNDABLE_CNY`), each re-check's share and a halved episode");
  // Nobody writes the numbers again: no ¥1.2 / 120 cents, no 0.25 share, in the server's budget code.
  for (const file of ["agendaBudget.mjs", "autopilotService.mjs"]) {
    const code = readFileSync(path.join(SRC, file), "utf8").split("\n").filter((text) => !/^\s*(\/\/|\*|\/\*)/.test(text)).join("\n");
    assert.doesNotMatch(code, /\b1\.2\b|VERIFICATION_BUDGET_SHARE\s*=|\b0\.25\b/, `${file} restates a number the domain owns`);
  }
});

test("no dispatch path asks the account's ledger a question about an agenda's caps", () => {
  const server = readFileSync(path.join(SRC, "server.mjs"), "utf8");
  // Both dispatch closures ask the service, which asks the two questions apart; neither reads a cap itself.
  assert.equal((server.match(/autopilotService\.assertAffordable\(/g) ?? []).length, 2, "the episode and its verification");
  assert.equal((server.match(/autopilotService\.runScope\(/g) ?? []).length, 2);
  assert.doesNotMatch(server, /agenda\.payload\.(?:daily|weekly)BudgetCny/);
  assert.doesNotMatch(server, /function minimumPositive/, "the helper that took the smaller of the agenda's cap and the account's is gone with its callers");
});
