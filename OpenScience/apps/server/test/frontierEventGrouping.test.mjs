// What the event layer asks the model and how it reads the answers (fr-events 2026-10-22): the grouping call's input and
// its four relations, the second look, and the overview's checks.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDigestInput } from "../src/frontierEditor.mjs";
import {
  FRONTIER_EVENT_DIGEST_INSTRUCTIONS,
  FRONTIER_GROUP_INSTRUCTIONS,
  FRONTIER_GROUP_PAIR_INSTRUCTIONS,
  buildGroupInput,
  buildGroupPairInput,
  groupCandidateKey,
  validateGroupAnswer,
  validateGroupPair,
  verifyEventDigest,
} from "../src/frontierEventGrouping.mjs";

const paper = { sourceName: "NEJM", primary: true, titleRaw: "Semaglutide and kidney outcomes", titleZh: "司美格鲁肽与肾脏结局",
  summaryZh: "FLOW 试验纳入 3533 名患者。", publishedAt: "2026-10-20T02:00:00Z", doi: "10.1056/x", registryIds: ["NCT03819153"],
  evidenceType: "rct", text: "Among 3533 patients, the risk was 24% lower." };
const coverage = { sourceName: "STAT", titleRaw: "Ozempic cuts kidney risk", titleZh: "司美格鲁肽降低肾脏风险", summaryZh: "媒体报道。",
  publishedAt: "2026-10-20T08:00:00Z" };

test("the grouping input: the new report with its original, each candidate with its representative and what is selected of it", () => {
  const input = buildGroupInput({ report: paper, candidates: [
    { title: "FLOW 试验结果", members: 3, report: coverage, selected: coverage },
    { title: "另一事件", members: 1, report: { ...coverage, titleZh: "无关" }, selected: null },
  ] }, { timeZone: "Asia/Shanghai" });
  assert.match(input, /^【新报道】\n标题：司美格鲁肽与肾脏结局\n原标题：Semaglutide and kidney outcomes\n来源：NEJM（一手来源）｜发布日期：2026-10-20/);
  assert.match(input, /标识：DOI 10\.1056\/x；注册号 NCT03819153/);
  assert.match(input, /【原文】\nAmong 3533 patients, the risk was 24% lower\.\n【原文结束】/);
  assert.match(input, /【候选 C1】（该事件已有 3 篇报道；事件标题：FLOW 试验结果）/);
  assert.match(input, /【已入选】（新增信息只与这篇已入选的报道比较）/);
  assert.match(input, /【候选 C2】[\s\S]*【尚未入选】该候选只用于身份判断。/);
  assert.equal(groupCandidateKey(0), "C1");
  // The instructions carry the rules the clustering already learned (2026-09-22): a series of one publisher's notices, and two
  // works with their own identifiers, are different occurrences.
  for (const instructions of [FRONTIER_GROUP_INSTRUCTIONS, FRONTIER_GROUP_PAIR_INSTRUCTIONS]) {
    assert.match(instructions, /同一机构按同一格式发布的系列公告/);
    assert.match(instructions, /不同 DOI 或 PMID 的论文是两项不同的研究/);
    assert.match(instructions, /SAME_OCCURRENCE\|SAME_STORY\|UNRELATED\|ROUNDUP/);
  }
  assert.match(FRONTIER_GROUP_INSTRUCTIONS, /"selection":\{"addsValue"/);
});

test("an answer covers every candidate exactly once with a known relation, or it is no answer", () => {
  const answer = { query: "FLOW 结果发表", decisions: [{ id: "C2", relation: "unrelated", confidence: 0.9 }, { id: "C1", relation: "SAME_OCCURRENCE", confidence: 1.4, note: "同一篇论文" }],
    selection: { addsValue: false, reason: "已入选报道已写出主要结果" } };
  const read = validateGroupAnswer(2, answer);
  assert.deepEqual(read?.decisions.map((decision) => [decision.relation, decision.confidence]), [["SAME_OCCURRENCE", 1], ["UNRELATED", 0.9]],
    "by candidate, whatever the order; the confidence clamped to 0–1");
  assert.deepEqual(read?.selection, { addsValue: false, reason: "已入选报道已写出主要结果" });
  assert.equal(validateGroupAnswer(3, answer), null, "a missing candidate is a failure, never an UNRELATED");
  assert.equal(validateGroupAnswer(2, { decisions: [answer.decisions[1], answer.decisions[1]] }), null, "a candidate answered twice");
  assert.equal(validateGroupAnswer(2, { decisions: [answer.decisions[0], { id: "C1", relation: "yes" }] }), null, "an unknown relation");
  assert.equal(validateGroupAnswer(2, { decisions: [answer.decisions[0], { id: "C9", relation: "UNRELATED" }] }), null, "an unknown id");
  assert.equal(validateGroupAnswer(1, null), null);
  assert.equal(validateGroupAnswer(2, { ...answer, selection: { addsValue: "no" } })?.selection, null, "a reading value that is not a boolean is unknown");
});

test("the second look reads two reports alone and answers one relation", () => {
  const input = buildGroupPairInput(coverage, paper, { timeZone: "Asia/Shanghai" });
  assert.match(input, /^【报道 A】\n标题：司美格鲁肽降低肾脏风险/);
  assert.match(input, /【报道 B】\n标题：司美格鲁肽与肾脏结局/);
  assert.doesNotMatch(input, /【原文】/, "the pair is judged on what both reports state");
  assert.deepEqual(validateGroupPair({ relation: "same_story", confidence: 0.8, difference: "评论在后" }), { relation: "SAME_STORY", confidence: 0.8, difference: "评论在后" });
  assert.equal(validateGroupPair({ relation: "maybe" }), null);
  assert.equal(validateGroupPair(null), null);
});

test("the overview: a title and one to three paragraphs, Chinese, no links, no number the reports do not state", () => {
  const input = buildDigestInput({ reports: [{ role: "primary", sourceName: "NEJM", titleRaw: "FLOW", titleZh: "FLOW 试验",
    summaryZh: "纳入 3533 名患者，风险降低 24%。", publishedAt: "2026-10-20T02:00:00Z" }] }, { timeZone: "Asia/Shanghai" });
  const good = verifyEventDigest({ title: "司美格鲁肽降低慢性肾病患者肾脏风险", digest: "FLOW 试验显示司美格鲁肽使肾脏事件风险降低 24%。\n\n试验纳入 3533 名患者。" }, input);
  assert.deepEqual(good.issues, []);
  assert.equal(good.output.digest, "FLOW 试验显示司美格鲁肽使肾脏事件风险降低 24%。\n\n试验纳入 3533 名患者。", "the paragraphs are kept");
  const escaped = verifyEventDigest({ title: "司美格鲁肽降低肾脏风险", digest: "第一段说清结论。\\n\\n第二段补充背景。" }, input);
  assert.equal(escaped.output.digest, "第一段说清结论。\n\n第二段补充背景。", "an escaped blank line is a paragraph break too");
  const bad = verifyEventDigest({ title: "x".repeat(40), digest: "风险降低 25%，详见 www.nejm.org。" }, input);
  assert.ok(bad.issues.some((issue) => issue.includes("title 太长")));
  assert.ok(bad.issues.some((issue) => issue.includes("链接")));
  assert.ok(bad.issues.some((issue) => issue.includes("「25%」")), "a number the reports do not state");
  assert.ok(verifyEventDigest({ title: "标题", digest: "一。\n\n二。\n\n三。\n\n四。" }, input).issues.includes("digest 最多分成 3 段。"));
  assert.ok(verifyEventDigest(null, input).issues.length >= 2);
  assert.match(FRONTIER_EVENT_DIGEST_INSTRUCTIONS, /\{"title":"","digest":""\}/);
});
