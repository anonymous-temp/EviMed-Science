// 追踪's pure parts: a congress's patterns, and what a day's recap must be before it is kept.
import assert from "node:assert/strict";
import test from "node:test";
import { frontierCongressById } from "@evimed/domain";
import {
  FRONTIER_CONGRESS_RECAP_INSTRUCTIONS,
  FRONTIER_RECAP_LIMITS,
  buildRecapInput,
  frontierCongressPatterns,
  frontierWriteCongressRecap,
  verifyCongressRecap,
} from "../src/frontierTrack.mjs";

const refs = [
  { n: 1, itemId: "aaaaaaaaaaaaaaaa", date: "2026-10-24", sourceName: "医脉通", title: "药物 A 三期试验公布", summary: "药物 A 对比化疗使死亡风险降低 32%，随机对照试验，中位随访 18 个月。" },
  { n: 2, itemId: "bbbbbbbbbbbbbbbb", date: "2026-10-24", sourceName: "OncLive", title: "Drug B early data", summary: "药物 B 的期中分析显示客观缓解率为 45%，非随机研究。" },
];
const input = buildRecapInput({ name: "欧洲肿瘤内科学会年会", code: "ESMO 2026" }, refs);
const GOOD = "药物 A 在随机对照试验中使死亡风险降低 32%，中位随访 18 个月[1]。药物 B 的期中分析显示客观缓解率为 45%，但属于非随机研究，结论还需要更大样本验证[2]。两项结果都是会议报告的初步内容，还要等完整发表和同行评议后才能判断对临床实践的影响[1][2]。";

test("the recap call is shown the congress and the day's items, numbered, with their 导读 and no date of its own", () => {
  assert.match(input, /【会议】欧洲肿瘤内科学会年会（ESMO 2026）/);
  assert.match(input, /\[1\] 医脉通｜药物 A 三期试验公布\n    导读：药物 A/);
  assert.match(input, /\[2\] OncLive｜Drug B early data/);
  assert.match(FRONTIER_CONGRESS_RECAP_INSTRUCTIONS, /设计局限/);
  assert.match(FRONTIER_CONGRESS_RECAP_INSTRUCTIONS, /不写日期/);
});

test("a recap of three sentences, marked with the items it was shown and holding only their numbers, passes", () => {
  const checked = verifyCongressRecap({ recap_zh: GOOD }, input, refs);
  assert.deepEqual(checked.issues, []);
  assert.deepEqual(checked.cited, [1, 2]);
  assert.equal(checked.output.recap_zh, GOOD);
});

test("a number the items do not have is refused, and so is a mark that names no item", () => {
  const invented = verifyCongressRecap({ recap_zh: GOOD.replace("32%", "40%") }, input, refs);
  assert.ok(invented.issues.some((issue) => issue.includes("40")), invented.issues.join("|"));
  const unknown = verifyCongressRecap({ recap_zh: GOOD.replace("[2]", "[7]") }, input, refs);
  assert.ok(unknown.issues.some((issue) => issue.includes("[7]")));
  const unmarked = verifyCongressRecap({ recap_zh: GOOD.replace(/\[\d\]/g, "") }, input, refs);
  assert.ok(unmarked.issues.some((issue) => issue.includes("没有标注")));
});

test("a recap is three to six sentences of one paragraph within its length, and empty is a valid answer", () => {
  const short = verifyCongressRecap({ recap_zh: "药物 A 使死亡风险降低 32%[1]。药物 B 的客观缓解率为 45%[2]。" }, input, refs);
  assert.ok(short.issues.some((issue) => issue.includes("太短") || issue.includes("3 到 6 句")));
  const twoSentences = verifyCongressRecap({ recap_zh: `${GOOD.split("。")[0]}。${GOOD.split("。")[1]}。` }, input, refs);
  assert.ok(twoSentences.issues.some((issue) => issue.includes("3 到 6 句")));
  const broken = verifyCongressRecap({ recap_zh: GOOD.replace("。药物 B", "。\n药物 B") }, input, refs);
  assert.ok(broken.issues.some((issue) => issue.includes("一段话")));
  const empty = verifyCongressRecap({ recap_zh: "" }, input, refs);
  assert.deepEqual(empty.issues, []);
  assert.equal(empty.output.recap_zh, null);
  const longer = verifyCongressRecap({ recap_zh: `${GOOD}${GOOD}` }, input, refs);
  assert.ok([...(longer.output.recap_zh ?? "")].length <= FRONTIER_RECAP_LIMITS.max, "too long is cut by whole sentences");
  assert.ok(verifyCongressRecap(null, input, refs).issues.length > 0);
  assert.ok(verifyCongressRecap({ recap_zh: "Drug A reduced the risk of death by 32% and drug B had a response rate of 45%, both preliminary [1][2]." }, input, refs).issues.some((issue) => issue.includes("中文")));
});

test("a recap keeps only the references it cites, in the shape the table stores", async () => {
  const editor = { writeJson: async (_instructions, shown, _max, { verify }) => {
    assert.equal(shown, input);
    const checked = verify({ recap_zh: GOOD.replace("[1][2]", "[1]") });
    return { verification: "passed", output: checked.output };
  } };
  const result = await frontierWriteCongressRecap(editor, { congress: { name: "欧洲肿瘤内科学会年会", code: "ESMO 2026" }, refs });
  assert.equal(result.verification, "passed");
  assert.deepEqual(result.refs, [{ n: 1, itemId: "aaaaaaaaaaaaaaaa" }, { n: 2, itemId: "bbbbbbbbbbbbbbbb" }]);
  const dropped = await frontierWriteCongressRecap({ writeJson: async () => ({ verification: "dropped", output: null, issues: ["x"] }) }, { congress: { name: "n", code: "c" }, refs });
  assert.equal(dropped.text, null);
  assert.deepEqual(dropped.refs, []);
});

test("a congress is found by its keywords and by its code with its year in either order, never by the code's name alone", () => {
  const esmo = frontierCongressPatterns(frontierCongressById("esmo-2026"));
  const matches = (/** @type {string} */ text) => esmo.some((pattern) => new RegExp(pattern, "i").test(text));
  assert.equal(matches("Results presented at ESMO 2026"), true);
  assert.equal(matches("信达在2026 ESMO首次公布 I 期数据"), true);
  assert.equal(matches("在ESMO大会上公布"), true);
  assert.equal(matches("the ESMO Congress in Madrid"), true);
  assert.equal(matches("欧洲肿瘤内科学会年会"), true);
  assert.equal(matches("ESMO guidelines for gastric cancer"), false);
  const chest = frontierCongressPatterns(frontierCongressById("chest-2026"));
  assert.equal(chest.some((pattern) => new RegExp(pattern, "i").test("chest pain in the emergency department")), false);
  assert.equal(chest.some((pattern) => new RegExp(pattern, "i").test("CHEST 2026 abstracts")), true);
  const ama = frontierCongressPatterns(frontierCongressById("aha-2026"));
  assert.equal(ama.some((pattern) => new RegExp(pattern, "i").test("Aha! a new finding")), false);
});

test("the tracker's counters are metrics: records by kind, fields refused by reason, recaps by outcome", async () => {
  const { frontierMetricFamilies } = await import("../src/frontierService.mjs");
  const counters = { asked: 10, approvals: 4, guidelines: 3, none: 2, failed: 1, droppedFields: { "agency:alias": 2, "date:stale": 1 },
    recapsAsked: 3, recapsWritten: 2, recapsEmpty: 1, recapsDropped: 0, recapsFailed: 0 };
  const families = frontierMetricFamilies(true, {
    tables: null, composer: null, actions: null, editor: null, budget: { spentCny: 0, budgetCny: 10, state: "ok" },
    worker: { pipeline: {}, loops: {}, track: { counters } }, client: { counters: { requests: 0, retries: 0, failures: 0 } },
    service: { lists: 0, notModified: 0, cacheHits: 0, invalidCursors: 0, searches: 0, searchFailures: 0 },
    plugin: { state: "ok", contract: "1.7.0", compatibility: "compatible", lastError: null, cursor: 1, latestSeq: 1, lag: 0, lastPullOkAt: null, lastMirrorAt: null,
      gaps: { count: 0, entries: 0 }, unknownVocabulary: {}, counters: { pulls: 1, pullFailures: 0, inserted: 0, duplicates: 0, dropped: 0, invalid: 0, placeholders: 0 }, pluginHealthDetail: null },
  });
  const named = (/** @type {string} */ name) => families.find((entry) => entry.name === name);
  assert.deepEqual(named("open_science_frontier_track_total")?.series.map((entry) => [entry.labels?.kind, entry.value]),
    [["asked", 10], ["approvals", 4], ["guidelines", 3], ["none", 2], ["failed", 1]]);
  assert.deepEqual(named("open_science_frontier_track_dropped_total")?.series.map((entry) => [entry.labels?.field, entry.labels?.reason, entry.value]),
    [["agency", "alias", 2], ["date", "stale", 1]]);
  assert.deepEqual(named("open_science_frontier_track_recaps_total")?.series.map((entry) => [entry.labels?.outcome, entry.value]),
    [["asked", 3], ["written", 2], ["empty", 1], ["dropped", 0], ["failed", 0]]);
});
