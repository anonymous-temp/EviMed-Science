// The reader's 导读 paragraph and 「AI 解读」 (frontierLead.mjs, frontierInsight.mjs, 2026-10-22), the full text of an open-access
// PDF as contract paragraphs (frontierFullTextParagraphs), and a translated section heading keeping its mark.
import assert from "node:assert/strict";
import test from "node:test";
import { verifyParagraph } from "../src/frontierEditor.mjs";
import { FRONTIER_INSIGHT_LIMITS, buildInsightInput, frontierInsightBasis, frontierInsightWorthAsking, frontierWriteInsight, verifyInsight } from "../src/frontierInsight.mjs";
import { FRONTIER_LEAD_LIMITS, buildLeadInput, frontierWriteLead, verifyLead } from "../src/frontierLead.mjs";
import { frontierFullTextParagraphs } from "../src/frontierReaderTidy.mjs";

const SOURCE = ["B-Well 1 和 B-Well 2 两项 III 期试验合并数据显示，基线 HBsAg≤3000 IU/ml 人群功能性治愈率 19%（233/1220），安慰剂组 0%（0/614），",
  "两项研究 p 均<0.001。最常见的不良事件为注射部位红斑、局部疼痛和一过性肝酶升高。Bepirovirsen 已在中国申报上市。"].join("");
const input = buildLeadInput({ sourceName: "丁香园肿瘤时间", date: "2026-10-21", titleRaw: "全球首创乙肝功能性治愈疗法获 FDA 批准上市",
  text: SOURCE, kind: "body" });

test("the 导读 is shown its source, date, title and the reader text, the head of a long one", () => {
  assert.match(input, /^来源：丁香园肿瘤时间\n日期：2026-10-21\n标题：全球首创/);
  assert.match(input, /正文（全文）：\n B-Well|正文（全文）：\nB-Well/);
  const long = buildLeadInput({ sourceName: "S", titleRaw: "T", text: "字".repeat(FRONTIER_LEAD_LIMITS.input + 500), kind: "abstract" });
  assert.ok(long.endsWith("…") && long.includes("正文（摘要）"));
  assert.match(buildLeadInput({ sourceName: "S", titleRaw: "T", text: "post", kind: "body", post: true }), /正文（帖子）/);
});

test("the 导读's checks: one paragraph in Chinese, within the length, every number in the source; an empty answer is no 导读", () => {
  const good = "FDA 批准 GSK 的反义寡核苷酸 Bepirovirsen 与核苷（酸）类似物联用治疗慢性乙肝。B-Well 1 和 B-Well 2 合并数据显示，基线 HBsAg≤3000 IU/ml 人群功能性治愈率 19%（233/1220），安慰剂组 0%（0/614）。最常见不良事件为注射部位红斑、局部疼痛和一过性肝酶升高；该药已在中国申报上市。";
  assert.deepEqual(verifyLead({ lead_zh: good }, input).issues, []);
  assert.equal(verifyLead({ lead_zh: good }, input).output.lead_zh, good);
  assert.ok(verifyLead({ lead_zh: good.replace("19%", "27%") }, input).issues.some((issue) => issue.includes("27%")), "a number not in the source");
  assert.ok(verifyLead({ lead_zh: `${good}\n第二段。` }, input).issues.some((issue) => issue.includes("一段话")));
  assert.ok(verifyLead({ lead_zh: "- 决定：FDA 批准。\n- 依据：B-Well。" }, input).issues.length > 0, "points and headings are not a paragraph");
  assert.ok(verifyLead({ lead_zh: "字".repeat(FRONTIER_LEAD_LIMITS.chars + 1) }, input).issues.some((issue) => issue.includes("太长")));
  assert.ok(verifyLead({ lead_zh: "The FDA approved bepirovirsen for chronic hepatitis B in adults." }, input).issues.some((issue) => issue.includes("中文")));
  assert.deepEqual(verifyLead({ lead_zh: "" }, input), { output: { lead_zh: null }, issues: [], numbers: { missing: [], checked: 0, unitMismatches: [] } });
  assert.ok(verifyLead(null, input).issues.length > 0);
});

test("one 导读 through the editor's metered call and its one rewrite", async () => {
  /** @type {any[]} */
  const calls = [];
  const editor = {
    async writeJson(/** @type {string} */ instructions, /** @type {string} */ modelInput, /** @type {number} */ maxTokens, /** @type {any} */ options) {
      calls.push({ instructions, modelInput, maxTokens });
      const checked = options.verify({ lead_zh: "FDA 批准 Bepirovirsen 用于慢性乙肝，基线 HBsAg≤3000 IU/ml 人群功能性治愈率 19%。" });
      return { verification: checked.issues.length ? "dropped" : "passed", output: checked.output, error: null };
    },
  };
  const result = await frontierWriteLead(editor, { sourceName: "丁香园肿瘤时间", titleRaw: "T", text: SOURCE, kind: "body" });
  assert.equal(result.verification, "passed");
  assert.match(String(result.lead), /19%/);
  assert.match(calls[0].instructions, /一段话，三到五句/);
});

/** @type {import("../src/frontierInsight.mjs").FrontierInsightRef[]} */
const refs = [
  { n: 1, itemId: "11", publicId: "p11", relation: "same-event", sourceName: "GSK", date: "2026-10-20", title: "GSK：Bepirovirsen 获 FDA 批准", summary: "GSK 宣布 FDA 批准。" },
  { n: 2, itemId: "12", publicId: "p12", relation: "entity", sourceName: "NEJM", date: "2025-11-08", title: "B-Well 1 和 2 试验结果", summary: "两项 III 期试验功能性治愈率 19%。" },
];
const insightInput = buildInsightInput({ sourceName: "丁香园肿瘤时间", date: "2026-10-21", title: "全球首创乙肝功能性治愈疗法获批", lead: "导读。", text: SOURCE, refs });

test("the 解读 is shown the item and its related reports under their numbers, or that there are none", () => {
  assert.match(insightInput, /【这条消息】\n来源：丁香园肿瘤时间/);
  assert.match(insightInput, /\[1\] 同一事件｜2026-10-20｜GSK｜GSK：Bepirovirsen 获 FDA 批准\n {4}导读：GSK 宣布 FDA 批准。/);
  assert.match(insightInput, /\[2\] 同一药物或试验｜2025-11-08｜NEJM/);
  assert.match(buildInsightInput({ sourceName: "S", title: "T", text: "x", refs: [] }), /【相关报道】无/);
});

test("the 解读's checks: every mark names a report it was shown, numbers in the material, long enough, one paragraph; empty is no 解读", () => {
  const good = "这次获批的依据与 2025 年公布的 B-Well 两项 III 期试验一致，功能性治愈率同为 19% [2]。GSK 的公告与这篇报道给出的适应证相同 [1]。国内仍在审评，正大天晴持有中国商业化权益，上市时间尚无消息，长期停药后的持久性也还要更长随访来回答。";
  const checked = verifyInsight({ insight_zh: good }, insightInput, refs);
  assert.deepEqual(checked.issues, []);
  assert.deepEqual(checked.cited, [2, 1]);
  assert.ok(verifyInsight({ insight_zh: good.replace("[1]", "[3]") }, insightInput, refs).issues.some((issue) => issue.includes("[3]")));
  assert.ok(verifyInsight({ insight_zh: "太短了 [1]。" }, insightInput, refs).issues.some((issue) => issue.includes("太短")));
  assert.ok(verifyInsight({ insight_zh: good.replace("19%", "23%") }, insightInput, refs).issues.some((issue) => issue.includes("23%")));
  assert.ok(verifyInsight({ insight_zh: `${good}\n另一段。` }, insightInput, refs).issues.some((issue) => issue.includes("一段话")));
  assert.deepEqual(verifyInsight({ insight_zh: "" }, insightInput, refs).output, { insight_zh: null });
  assert.equal(verifyInsight({ insight_zh: "  " }, insightInput, refs).issues.length, 0);
});

test("when a 解读 is asked for, and the basis it is kept with", async () => {
  assert.equal(frontierInsightWorthAsking({ text: "短。", refs }), true, "related reports are material");
  assert.equal(frontierInsightWorthAsking({ text: "短。", refs: [] }), false, "no related report and a short text: nothing to put in context");
  assert.equal(frontierInsightWorthAsking({ text: "字".repeat(FRONTIER_INSIGHT_LIMITS.aloneMinChars), refs: [] }), true);
  assert.equal(frontierInsightBasis("sha", refs), frontierInsightBasis("sha", [...refs].reverse()), "the related reports' order does not matter");
  assert.notEqual(frontierInsightBasis("sha", refs), frontierInsightBasis("sha", refs.slice(0, 1)), "a new or gone report does");
  assert.notEqual(frontierInsightBasis("sha", refs), frontierInsightBasis("other", refs), "and so does the text");
  const editor = {
    async writeJson(/** @type {string} */ _instructions, /** @type {string} */ _input, /** @type {number} */ _max, /** @type {any} */ options) {
      const checked = options.verify({ insight_zh: "与此前公布的 B-Well 试验结果一致，功能性治愈率同为 19% [2]；公告给出的适应证与本报道相同 [1]，国内仍在审评，上市时间与长期停药后的持久性还有待更多数据。" });
      return { verification: checked.issues.length ? "dropped" : "passed", output: checked.output, error: null };
    },
  };
  const written = await frontierWriteInsight(editor, { sourceName: "S", title: "T", text: SOURCE, refs });
  assert.deepEqual([written.verification, written.cited], ["passed", [2, 1]]);
});

test("an open-access PDF's text becomes the contract's paragraphs: headings marked, references and what follows cut", () => {
  const parsed = ["# A randomized trial of X", "", "Abstract text that opens the paper and runs on for a while.", "", "## Methods", "",
    "We enrolled 1,220 adults across 29 countries.\nRandomisation was 2:1.", "", "## Results", "", `${"Functional cure was 19%. ".repeat(60)}`, "",
    "## References", "", "1. Someone et al. A paper. 2024.", "", "## Supplementary", "", "More."].join("\n");
  const body = frontierFullTextParagraphs(parsed, { minChars: 200 });
  assert.ok(body);
  const paragraphs = String(body).split("\n\n");
  assert.deepEqual(paragraphs.slice(0, 5), ["## A randomized trial of X", "Abstract text that opens the paper and runs on for a while.", "## Methods",
    "We enrolled 1,220 adults across 29 countries. Randomisation was 2:1.", "## Results"]);
  assert.ok(!String(body).includes("Someone et al.") && !String(body).includes("More."), "nothing after the references");
  assert.equal(frontierFullTextParagraphs("## Title\n\nToo short to be the article."), null);
  const long = frontierFullTextParagraphs(Array.from({ length: 40 }, (_, index) => `Paragraph ${index} ${"word ".repeat(40)}`).join("\n\n"), { limit: 1_000, minChars: 10 });
  assert.ok(long && long.length <= 1_000 && long.endsWith("word"), "cut at a paragraph end within the limit");
});

test("a translated section heading keeps its mark, and a paragraph that is not one never gains it", () => {
  assert.equal(verifyParagraph("方法", "## Methods"), "## 方法");
  assert.equal(verifyParagraph("## 结果", "## Results"), "## 结果");
  assert.equal(verifyParagraph("## 我们纳入了 1,220 名成人。", "We enrolled 1,220 adults."), "我们纳入了 1,220 名成人。");
});
