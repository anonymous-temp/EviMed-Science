// The daily without a database (build spec D.2, D.3): the zone's clock and
// window, what an issue holds (no padding, the lead by the hot list), its
// Markdown, and the notice it is pushed as — which carries nothing personal.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FRONTIER_DAILY_SECTION_MAX,
  FRONTIER_READING_CHARS_PER_MINUTE,
  clockMinutes,
  dayLabel,
  frontierDailyIssue,
  frontierDailyMarkdown,
  frontierDailyNotice,
  frontierDailyWindow,
  frontierReadingMinutes,
  previousDay,
  zonedClock,
  zonedInstant,
} from "../src/frontierDaily.mjs";
import { noticeLink } from "../src/imService.mjs";

const ZONE = "Asia/Shanghai";

test("the zone's clock, not the container's: 23:30 UTC is 07:30 of the next day in Beijing", () => {
  assert.deepEqual(zonedClock(new Date("2026-09-21T23:30:00Z"), ZONE), { day: "2026-09-22", minutes: 7 * 60 + 30, clock: "07:30" });
  assert.equal(zonedInstant("2026-09-22", 7 * 60, ZONE).toISOString(), "2026-09-21T23:00:00.000Z");
  assert.equal(zonedInstant("2026-03-01", 0, ZONE).toISOString(), "2026-02-28T16:00:00.000Z");
  assert.equal(previousDay("2026-03-01"), "2026-02-28");
  assert.equal(previousDay("2026-01-01"), "2025-12-31");
  assert.equal(clockMinutes("07:30"), 450);
  assert.equal(clockMinutes("24:00"), null);
  assert.equal(clockMinutes("7:30"), null);
  assert.equal(dayLabel("2026-09-02"), "2026年9月2日");
});

test("an issue covers [D−1 07:00, D 07:00) Beijing time, and never a window that ends after it is written", () => {
  const window = frontierDailyWindow("2026-09-22", { timeZone: ZONE, dailyTime: "07:30" });
  assert.equal(window.start.toISOString(), "2026-09-20T23:00:00.000Z");
  assert.equal(window.end.toISOString(), "2026-09-21T23:00:00.000Z");
  const early = frontierDailyWindow("2026-09-22", { timeZone: ZONE, dailyTime: "06:15" });
  assert.equal(early.end.toISOString(), "2026-09-21T22:15:00.000Z", "a daily time before 07:00 moves the cut with it");
  assert.equal(early.end.getTime() - early.start.getTime(), 24 * 3_600_000);
});

const row = (id, overrides = {}) => ({
  id, public_id: `p${String(id).padStart(15, "0")}`, title_raw: `Item ${id}`, title_zh: `条目 ${id}`, summary_zh: `导读 ${id}`,
  lane: "evidence", selected: true, safety_alert: false, score_total: 70, visible_at: `2026-09-21T0${id % 10}:00:00Z`,
  canonical_url: `https://example.org/${id}`, source_name: "NEJM", event_id: null, ...overrides,
});

test("an issue: the lead by the hot list, safety alerts apart, a section only for a lane with selected items, none padded", () => {
  const rows = [
    row(1, { score_total: 90 }),
    row(2, { score_total: 75, event_id: "7" }),
    row(3, { lane: "regulatory", score_total: 72 }),
    row(4, { selected: false, lane: "ai", score_total: 50 }),
    row(5, { lane: "ai", score_total: 71 }),
    row(6, { safety_alert: true, lane: "safety", selected: true }),
    row(7, { lane: "guideline", selected: false }),
  ];
  const issue = frontierDailyIssue({ rows, hotEventIds: ["9", "7"] });
  assert.equal(issue.lead.id, 2, "an item whose event is on the hot list leads, over a higher score");
  assert.deepEqual(issue.safety.map((entry) => entry.id), [6]);
  assert.deepEqual(issue.sections.map((section) => section.lane), ["evidence", "regulatory", "ai"], "no guideline section: nothing selected there");
  assert.deepEqual(issue.sections[0].rows.map((entry) => entry.id), [1], "the lead is not repeated in its lane");
  assert.equal(issue.sections.some((section) => section.rows.some((entry) => entry.safety_alert)), false, "safety alerts are not repeated in a section");
  assert.deepEqual(issue.ai.map((entry) => entry.id), [5, 4], "the AI minute reads the AI lane, selected first");
  const withoutHot = frontierDailyIssue({ rows, hotEventIds: [] });
  assert.equal(withoutHot.lead.id, 1, "without a hot event the highest score leads");
  assert.equal(frontierDailyIssue({ rows: [row(8, { selected: false })] }), null, "a day with nothing selected and no alert is no issue");
  const many = frontierDailyIssue({ rows: Array.from({ length: 20 }, (_, index) => row(index + 10, { score_total: 60 + index })) });
  assert.equal(many.sections[0].rows.length, FRONTIER_DAILY_SECTION_MAX);
});

test("the Markdown: the window in Beijing time, each item with its source and a link, text that cannot break the format", () => {
  const window = frontierDailyWindow("2026-09-22", { timeZone: ZONE, dailyTime: "07:30" });
  const lead = row(1, { title_zh: "司美格鲁肽 [SELECT] 试验", source_name: "NEJM" });
  const markdown = frontierDailyMarkdown({ day: "2026-09-22", window, timeZone: ZONE, lead, leadText: "导读 *重点*",
    safety: [row(2, { safety_alert: true, title_zh: "说明书修订", source_name: "NMPA" })],
    sections: [{ lane: "regulatory", rows: [row(3, { source_name: "FDA" })] }], aiMinute: "AI 一分钟的内容。" });
  assert.match(markdown, /^# EviMed 医学前沿日报 · 2026年9月22日$/m);
  assert.match(markdown, /覆盖 9月21日 07:00 至 9月22日 07:00（北京时间），共 3 条。/);
  assert.match(markdown, /\*\*司美格鲁肽 \\\[SELECT\\\] 试验\*\*（NEJM）/);
  assert.match(markdown, /导读 \\\*重点\\\*/);
  assert.match(markdown, /## 安全警示\n\n- \*\*说明书修订\*\*（NMPA）：导读 2 \[原文\]\(https:\/\/example.org\/2\)/);
  assert.match(markdown, /## 审批监管\n\n- \*\*条目 3\*\*（FDA）/);
  assert.match(markdown, /## AI 一分钟\n\nAI 一分钟的内容。/);
  assert.match(markdown, /\n---\n\n来源：EviMed 前沿动态\n$/, "signed, and nothing about how it was made");
  assert.doesNotMatch(markdown, /逐字核对|由模型/);
});

test("reading time: the characters shown, whitespace aside, at 400 a minute — at least a minute", () => {
  assert.equal(FRONTIER_READING_CHARS_PER_MINUTE, 400);
  assert.equal(frontierReadingMinutes(["司".repeat(3_600)]), 9, "「约 9 分钟」");
  assert.equal(frontierReadingMinutes(["司".repeat(1_000), "美 格 鲁 肽".repeat(250), null, 7]), 5,
    "2,000 characters: the spaces between them and what is not text are not read");
  assert.equal(frontierReadingMinutes([]), 1);
  assert.equal(frontierReadingMinutes(["短"]), 1);
});

test("the notice: the day and the selected count in the title, the lead's title and the safety count as the body — nothing else", () => {
  const notice = frontierDailyNotice({ day: "2026-09-22", lead: { title: "司美格鲁肽减重 3 年结果" },
    sections: [{ lane: "evidence", itemIds: ["a", "b"] }, { lane: "regulatory", itemIds: ["c"] }], safety: ["d"] });
  assert.equal(notice.noticeType, "notify");
  assert.equal(notice.title, "今日前沿 · 9月22日 · 4 条精选");
  assert.equal(notice.body, "司美格鲁肽减重 3 年结果\n安全警示 1 条", "no lane counts, no instructions (plan 2026-09-23 C §1.13)");
  assert.equal(frontierDailyNotice({ day: "2026-09-22", lead: { title: "头条" }, sections: [], safety: [] }).body, "头条",
    "no safety alert, no safety line");
  assert.deepEqual(notice.source, { type: "digest", id: "frontier-daily:2026-09-22" });
  assert.equal(notice.idempotencyKey, "frontier-daily:2026-09-22");
  assert.equal(notice.groupKey, "frontier-daily:2026-09-22");
  assert.deepEqual(notice.actions, [{ id: "open", label: "查看日报", style: "primary" }]);
  assert.doesNotMatch(`${notice.title}${notice.body}`, /因为|与你相关/, "nothing personal: a Feishu binding may be a group chat");
  const config = { publicUrl: "https://science.example.com" };
  assert.equal(noticeLink(config, { source: notice.source }), "https://science.example.com/app/frontier?view=daily&day=2026-09-22");
  assert.equal(noticeLink(config, { source: { type: "digest", id: "frontier-daily:not-a-day" } }), "https://science.example.com/app/autopilot?digest=frontier-daily%3Anot-a-day");
});
