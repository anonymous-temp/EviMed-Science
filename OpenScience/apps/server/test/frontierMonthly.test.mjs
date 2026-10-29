import assert from "node:assert/strict";
import test from "node:test";
import { FRONTIER_MONTHLY_INSTRUCTIONS, FrontierEditor, buildMonthlyInput } from "../src/frontierEditor.mjs";
import { FrontierGlossary } from "../src/frontierGlossary.mjs";
import {
  FRONTIER_MONTHLY_EVENTS, frontierGroundedText, frontierMonthAdd, frontierMonthWindow, frontierMonthlyIssue, frontierMonthlyMarkdown, latestFrontierMonth,
} from "../src/frontierMonthly.mjs";

const corpus = buildMonthlyInput({ month: "2026-10", startDate: "2026-10-01", endDate: "2026-10-31", groups: [
  { label: "临床证据", intro: true, items: [
    { title: "司美格鲁肽使心血管事件减少 20%", summary: "SELECT 试验纳入 17,604 例患者。" },
    { title: "KEYNOTE-189 5 年随访", summary: "帕博利珠单抗联合化疗的总生存获益持续。" },
    { title: "SGLT2 抑制剂用于心衰", summary: "达格列净降低住院风险。" }] },
  { label: "药物安全", intro: false, items: [{ title: "FDA 要求某药新增黑框警告", summary: "涉及肝损伤风险。" }] },
] });
const glossary = new FrontierGlossary([
  { kind: "drug", termEn: "semaglutide", termZh: "司美格鲁肽", keepOriginal: false },
  { kind: "drug", termEn: "tirzepatide", termZh: "替尔泊肽", keepOriginal: false },
  { kind: "org", termEn: "EMA", termZh: "欧洲药品管理局", keepOriginal: false },
]);

test("a month's window, its neighbours, and the last complete month due from the 1st's daily time", () => {
  assert.equal(frontierMonthAdd("2026-12"), "2027-01");
  assert.equal(frontierMonthAdd("2026-01", -1), "2025-12");
  const window = frontierMonthWindow("2026-02", "Asia/Shanghai");
  assert.deepEqual([window.first, window.last, window.start.toISOString(), window.end.toISOString()],
    ["2026-02-01", "2026-02-28", "2026-01-31T16:00:00.000Z", "2026-02-28T16:00:00.000Z"]);
  assert.throws(() => frontierMonthWindow("2026-13", "UTC"), { code: "frontier_month_invalid" });
  const options = { timeZone: "Asia/Shanghai", dailyTime: "07:30" };
  assert.equal(latestFrontierMonth(new Date("2026-10-31T23:00:00Z"), options), "2026-09", "07:00 on 1 November in Beijing: not yet");
  assert.equal(latestFrontierMonth(new Date("2026-10-31T23:31:00Z"), options), "2026-10", "07:31: October is due");
  assert.equal(latestFrontierMonth(new Date("2026-10-15T00:00:00Z"), options), "2026-09");
});

test("a sentence that names anything outside the entries is replaced by the template sentence, once; what stands is the model's own", () => {
  const template = "本月精选 4 件要事，临床证据 3 件、药物安全 1 件。";
  const grounded = (/** @type {string} */ text, max = 340) => frontierGroundedText(text, { corpus, max, template, glossary });
  const good = "本月临床证据集中在心血管代谢领域，司美格鲁肽在 SELECT 试验中使事件减少 20%。KEYNOTE-189 的 5 年随访显示获益持续。";
  assert.deepEqual(grounded(good), { text: good, replaced: 0 });
  // A number, a Latin name and a glossary term the entries do not have; a link; not Chinese.
  for (const [what, bad] of [["a number", "替代终点改善了 35%。"], ["a Latin name", "CheckMate-816 也报告了新数据。"],
    ["a glossary term", "替尔泊肽的减重效果更明显。"], ["a link", "详见 www.nejm.org 的原文。"], ["English", "Many trials were reported."]]) {
    const result = grounded(`${good}${bad}`);
    assert.equal(result.text, `${good}${template}`, what);
    assert.equal(result.replaced, 1, what);
  }
  const twice = grounded("替尔泊肽的减重效果更明显。欧洲药品管理局批准了新药。本月还有 99 项研究。");
  assert.deepEqual(twice, { text: template, replaced: 3 }, "the template once, however many sentences it replaces");
  assert.deepEqual(grounded(""), { text: template, replaced: 0 }, "nothing written: the template");
  assert.deepEqual(frontierGroundedText(null, { corpus, max: 90, template: null, glossary }), { text: null, replaced: 0 });
  // Too long: the leading whole sentences that fit.
  const long = `${good}${"SGLT2 抑制剂达格列净降低住院风险。".repeat(12)}`;
  const fitted = grounded(long, 120).text ?? "";
  assert.ok([...fitted].length <= 120 && fitted.startsWith("本月临床证据"));
});

test("the month's events: one per event, first-hand first, then the higher score, thirty at most, grouped by lane; Markdown signed", () => {
  const rows = Array.from({ length: 40 }, (_, index) => ({ id: index + 1, public_id: `p${index + 1}`, title_raw: `Item ${index + 1}`, title_zh: `条目 ${index + 1}`,
    summary_zh: `导读 ${index + 1}。`, lane: index % 3 === 0 ? "safety" : "evidence", score_total: 100 - index, event_id: index < 4 ? 77 : null,
    primary: index === 2, source_name: "NEJM", canonical_url: `https://example.org/${index + 1}` }));
  const issue = frontierMonthlyIssue(rows);
  assert.ok(issue);
  assert.equal(issue.top.length, FRONTIER_MONTHLY_EVENTS);
  assert.equal(issue.lead.public_id, "p3", "the event's first-hand report stands for it, and leads");
  assert.ok(!issue.top.some((row) => ["p1", "p2", "p4"].includes(row.public_id)), "one report per event");
  assert.deepEqual(issue.groups.map((group) => group.lane), ["evidence", "safety"], "the vocabulary's lane order");
  assert.equal(frontierMonthlyIssue([]), null);
  const markdown = frontierMonthlyMarkdown({ month: "2026-10", overview: "本月总述。", sections: [{ lane: "evidence", intro: "栏目导读。", rows: issue.groups[0].rows.slice(0, 2) }] });
  assert.match(markdown, /^# EviMed 医学前沿月报 · 2026年10月\n\n本月精选 2 件要事。\n\n## 本月总述\n\n本月总述。\n\n## 临床证据\n\n栏目导读。\n\n- \*\*条目 3\*\*（NEJM）：导读 3。 \[原文\]\(https:\/\/example.org\/3\)/);
  assert.ok(markdown.endsWith("来源：EviMed 前沿动态\n"));
});

test("the writer is one metered call with the month's entries, marked where an introduction is wanted; a failed call is the template's", async () => {
  /** @type {any[]} */
  const calls = [];
  const editor = new FrontierEditor({ deepseekProviderEnabled: true, deepseekApiKey: "test-only-key", frontierModel: "deepseek-flash" },
    { owner: { userId: "operator", projectId: "evimed-frontier" }, callModel: async (_deps, call) => {
      calls.push(call);
      return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ overview: "本月总述。", sections: { 临床证据: "栏目导读。", 无关: 3 } }) } }] };
    } });
  const groups = [{ label: "临床证据", intro: true, items: [{ title: "A", summary: "甲。" }] }, { label: "药物安全", intro: false, items: [{ title: "B", summary: null }] }];
  const written = await editor.writeMonthly({ month: "2026-10", startDate: "2026-10-01", endDate: "2026-10-31", groups });
  assert.deepEqual([written.overview, written.sections, written.error], ["本月总述。", { 临床证据: "栏目导读。" }, null]);
  assert.equal(calls[0].purpose, "frontier");
  assert.equal(calls[0].body.messages[0].content, FRONTIER_MONTHLY_INSTRUCTIONS);
  assert.equal(calls[0].body.messages[1].content, "本期：2026-10（2026-10-01 至 2026-10-31）\n【临床证据】写导读\n- A｜甲。\n【药物安全】\n- B｜");
  const failing = new FrontierEditor({ deepseekProviderEnabled: true, deepseekApiKey: "k" }, { owner: { userId: "o", projectId: "p" },
    callModel: async () => { throw Object.assign(new Error("x"), { code: "usage_budget_exceeded" }); } });
  const failed = await failing.writeMonthly({ month: "2026-10", startDate: "2026-10-01", endDate: "2026-10-31", groups });
  assert.deepEqual([failed.overview, failed.error], [null, "usage_budget_exceeded"]);
});
