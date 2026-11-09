import assert from "node:assert/strict";
import test from "node:test";
import { agendaLocalDate, DISPLAY_TIME_ZONE } from "../index.mjs";

test("a day is read in the zone a person lives in, not in UTC", () => {
  assert.equal(DISPLAY_TIME_ZONE, "Asia/Shanghai");
  // 22:30 UTC is already the next morning in China.
  assert.equal(agendaLocalDate("Asia/Shanghai", "2026-10-05T22:30:00Z"), "2026-10-06");
  assert.equal(agendaLocalDate("UTC", "2026-10-05T22:30:00Z"), "2026-10-05");
  assert.equal(agendaLocalDate("America/Los_Angeles", new Date("2026-10-06T05:00:00Z")), "2026-10-05");
});
