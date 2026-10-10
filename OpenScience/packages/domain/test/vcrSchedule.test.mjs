/**
 * The schedule of activities (a protocol's visits, with the windows around them and what is done at each): the exact operations the
 * platform does on it — which visit times a virtual-patient trajectory may take, how a day and a window read, what a schedule adds up
 * to — so that no run types a converted number.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  VCR_HORIZON_UNIT_DAYS,
  VCR_SOA_LIMITS,
  VCR_SOA_TIME_UNITS,
  soaDayText,
  soaSummary,
  soaVisitTimes,
  soaWindowText,
} from "@evimed/domain";

/** @param {string} name @param {number | null} day @param {string[]} [activities] @param {number | null} [windowDays] */
const visit = (name, day, activities = ["访视评估"], windowDays = null) =>
  ({ visit: name, day, windowDays, note: "", procedures: activities.map((entry) => ({ name: entry, note: "" })) });

/** The visit times of a schedule that can give them. @param {Parameters<typeof soaVisitTimes>[0]} visits @param {string} unit */
const timesOf = (visits, unit) => /** @type {{ ok: true, unit: string, baselineDay: number, times: number[] }} */ (soaVisitTimes(visits, unit));

const SCHEDULE = [
  visit("筛选期", -14, ["知情同意", "血常规"], 7),
  visit("基线", 1, ["体格检查", "血常规", "用药"], 0),
  visit("第 2 周", 15, ["血常规"], 3),
  visit("第 4 周", 29, ["血常规", "肿瘤评估"], 3),
  visit("第 8 周", 57, ["血常规", "肿瘤评估"], 3),
  visit("治疗结束", null, ["体格检查"]),
];

test("the time units are the platform's horizon units, and the limit is a closed number", () => {
  assert.deepEqual([...VCR_SOA_TIME_UNITS], Object.keys(VCR_HORIZON_UNIT_DAYS));
  assert.deepEqual([...VCR_SOA_TIME_UNITS], ["days", "weeks", "months", "years"]);
  assert.ok(Object.isFrozen(VCR_SOA_LIMITS));
  assert.ok(VCR_SOA_LIMITS.visits >= 50, "a schedule can be longer than the 50 visits a simulation takes");
});

test("a schedule adds up to visits, distinct activities and entries, and says how far it reaches", () => {
  assert.deepEqual(soaSummary(SCHEDULE), { visits: 6, activities: 5, entries: 11, firstDay: -14, lastDay: 57 });
  assert.deepEqual(soaSummary([]), { visits: 0, activities: 0, entries: 0, firstDay: null, lastDay: null });
  // the same activity under two spellings of case is one activity
  assert.equal(soaSummary([visit("a", 0, ["ECG"]), visit("b", 7, ["ecg"])]).activities, 1);
});

test("visit times are elapsed time from the baseline visit, the first at or after day 0, in the unit asked", () => {
  // screening (day -14) is before baseline and is not a time of the trajectory; the baseline is day 1, so day 15 is 14 days on: 0.46 months
  const days = soaVisitTimes(SCHEDULE, "days");
  assert.deepEqual(days, { ok: true, unit: "days", baselineDay: 1, times: [0, 14, 28, 56] });
  const weeks = timesOf(SCHEDULE, "weeks");
  assert.deepEqual(weeks.times, [0, 2, 4, 8]);
  const months = timesOf(SCHEDULE, "months");
  assert.deepEqual(months.times, [0, 0.46, 0.9199, 1.8398]);
  assert.equal(months.times[1], Math.round((14 / VCR_HORIZON_UNIT_DAYS.months) * 1e4) / 1e4);
  assert.ok(soaVisitTimes(SCHEDULE, "years").ok);
});

test("visit times refuse by name when there are not enough, when the unit is unknown, or when the unit would merge two visits", () => {
  assert.deepEqual(soaVisitTimes([visit("a", 0)], "weeks"), { ok: false, reason: "too_few_visits" });
  assert.deepEqual(soaVisitTimes([visit("a", -3), visit("b", -1)], "weeks"), { ok: false, reason: "too_few_visits" });
  assert.deepEqual(soaVisitTimes(SCHEDULE, "fortnights"), { ok: false, reason: "unit_unknown" });
  assert.deepEqual(soaVisitTimes([visit("a", 0), visit("b", 0.01)], "years"), { ok: false, reason: "unit_too_coarse" });
  const many = Array.from({ length: 51 }, (_, index) => visit(`v${index}`, index * 7));
  assert.deepEqual(soaVisitTimes(many, "days"), { ok: false, reason: "too_many_visits" });
  // two visits on one day are one time
  assert.deepEqual(timesOf([visit("a", 0), visit("b", 0), visit("c", 7)], "days").times, [0, 7]);
});

test("a day and a window read the way a protocol writes them", () => {
  assert.equal(soaDayText(28), "第 28 天");
  assert.equal(soaDayText(0), "第 0 天");
  assert.equal(soaDayText(-14), "第 -14 天");
  assert.equal(soaDayText(0.5), "第 0.5 天");
  assert.equal(soaDayText(null), "—");
  assert.equal(soaWindowText(3), "±3 天");
  assert.equal(soaWindowText(0), "±0 天");
  assert.equal(soaWindowText(null), "—");
});
