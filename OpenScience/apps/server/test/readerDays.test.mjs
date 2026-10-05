/**
 * A day a person reads is the day in their zone.
 *
 * `toISOString().slice(0, 10)` is the UTC day, and for the first eight hours of
 * every day in China it is yesterday: a 07:00 briefing was dated the day before
 * (commit 66cdc16a8). These are the other places that printed a date a reader
 * sees, each held at 23:30 UTC -- 07:30 the next morning in Asia/Shanghai, the
 * moment the two days disagree. What was judged and left as it is: the review
 * editor's "today" (it says 「UTC」 and is compared with dates the UTC runtime
 * wrote), idempotency keys and evaluation cycle ids (machine keys), calendar
 * arithmetic on a date that is already a date (`addDays`, `previousDay`,
 * `frontierCalendarDay`), and the provider's peak window.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { agendaLocalDate } from "@evimed/domain";
import { buildDigestInput, buildModelInput, buildSameEventInput } from "../src/frontierEditor.mjs";
import { frontierLibraryRecord } from "../src/frontierActions.mjs";
import { frontierSafetyNotice } from "../src/frontierNotifications.mjs";
import { shanghaiDay } from "../src/notificationService.mjs";

/** The moment the UTC day and the researcher's day disagree. */
const LATE = new Date("2026-09-21T23:30:00Z");

test("shanghaiDay is the one day-in-a-zone helper in the display zone, and unreadable input is no day", () => {
  assert.equal(LATE.toISOString().slice(0, 10), "2026-09-21");
  assert.equal(shanghaiDay(LATE), "2026-09-22");
  assert.equal(shanghaiDay(LATE), agendaLocalDate("Asia/Shanghai", LATE), "it is the domain's helper, not a second algorithm");
  assert.equal(shanghaiDay("2026-09-21T15:59:59Z"), "2026-09-21");
  assert.equal(shanghaiDay("2026-09-21T16:00:00Z"), "2026-09-22");
  assert.equal(shanghaiDay("not a date"), null);
  assert.equal(shanghaiDay(undefined), null);
});

test("a saved library record says when it was stored in the feed's zone, and the zone is the caller's to name", () => {
  const item = { title_raw: "A trial", source_name: "NEJM", canonical_url: "https://example.org/a", published_at: "2026-09-20T16:30:00Z", date_precision: "day" };
  assert.match(frontierLibraryRecord({ item, savedAt: LATE, day: "2026-09-21" }), /于 2026-09-22 存入/, "07:30 the next morning where the reader is");
  assert.match(frontierLibraryRecord({ item, savedAt: LATE, day: "2026-09-21", timeZone: "UTC" }), /于 2026-09-21 存入/);
  assert.match(frontierLibraryRecord({ item, savedAt: LATE, day: "2026-09-21", timeZone: "America/New_York" }), /于 2026-09-21 存入/);
});

test("a safety notice names the day the announcement was published in the feed's zone", () => {
  const row = { public_id: "a1b2c3d4e5f60718", title_raw: "Safety communication", primary_source_id: "fda", source_name: "FDA", published_at: "2026-09-21T20:00:00Z" };
  assert.match(frontierSafetyNotice(row).body, / · 2026-09-22$/, "20:00 UTC is 04:00 the next day in China");
  assert.match(frontierSafetyNotice(row, "UTC").body, / · 2026-09-21$/);
  assert.equal(frontierSafetyNotice({ ...row, published_at: "2026-09-21T15:00:00Z" }).body.endsWith(" · 2026-09-21"), true);
});

test("the dates the editor model is shown are the days the reader's card shows: the feed's zone, in the item, the digest and the same-event call", () => {
  const item = { sourceName: "NEJM", publishedAt: "2026-09-21T20:00:00Z", datePrecision: "instant", titleRaw: "A trial", allowedLanes: ["evidence"] };
  assert.match(buildModelInput(item), /发布日期：2026-09-22/);
  assert.match(buildModelInput(item, { timeZone: "UTC" }), /发布日期：2026-09-21/);
  assert.doesNotMatch(buildModelInput({ ...item, datePrecision: "inferred" }), /发布日期/, "an inferred date is still not stated");

  const reports = [{ role: "primary", sourceName: "NEJM", publishedAt: "2026-09-21T20:00:00Z", titleRaw: "A trial" }];
  assert.match(buildDigestInput({ reports }), /一手来源｜NEJM｜2026-09-22/);
  assert.match(buildDigestInput({ reports }, { timeZone: "UTC" }), /一手来源｜NEJM｜2026-09-21/);

  const report = { sourceName: "NEJM", titleRaw: "A trial", publishedAt: "2026-09-21T20:00:00Z", timelineAt: "2026-09-21T23:30:00Z",
    eventFirstAt: "2026-09-21T18:00:00Z", eventLastAt: "2026-09-22T01:00:00Z" };
  const shown = JSON.parse(buildSameEventInput({ report, candidates: [report] }));
  for (const side of [shown.new, shown.earlier[0]]) {
    assert.deepEqual([side.date, side.timeline_date, side.event_first_date, side.event_last_date], ["2026-09-22", "2026-09-22", "2026-09-22", "2026-09-22"]);
  }
  const utc = JSON.parse(buildSameEventInput({ report, candidates: [] }, { timeZone: "UTC" }));
  assert.deepEqual([utc.new.date, utc.new.timeline_date, utc.new.event_first_date, utc.new.event_last_date], ["2026-09-21", "2026-09-21", "2026-09-21", "2026-09-22"]);
});
