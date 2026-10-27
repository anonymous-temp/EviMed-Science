// The reader's 导读 paragraph (frontierLead.mjs, 2026-10-22), the full text of an open-access PDF as contract paragraphs
// (frontierFullTextParagraphs), and a translated section heading keeping its mark. (The 「AI 解读」 that shared this file was retired on
// 2026-10-27 with its pipeline step.)
import assert from "node:assert/strict";
import test from "node:test";
import { verifyParagraph } from "../src/frontierEditor.mjs";
import { FRONTIER_LEAD_GUIDES, FRONTIER_LEAD_INSTRUCTIONS, FRONTIER_LEAD_LIMITS, buildLeadInput, frontierLeadInstructions, frontierLeadLimit, frontierWriteLead,
  verifyLead } from "../src/frontierLead.mjs";
import { FRONTIER_GENRES } from "@evimed/domain";
import { FRONTIER_STYLE_CARDS } from "../src/frontierStyle.mjs";
import { frontierFullTextParagraphs, frontierGluedShare } from "../src/frontierReaderTidy.mjs";

const SOURCE = ["B-Well 1 和 B-Well 2 两项 III 期试验合并数据显示，基线 HBsAg≤3000 IU/ml 人群功能性治愈率 19%（233/1220），安慰剂组 0%（0/614），",
  "两项研究 p 均<0.001。最常见的不良事件为注射部位红斑、局部疼痛和一过性肝酶升高。Bepirovirsen 已在中国申报上市。"].join("");
const input = buildLeadInput({ sourceName: "丁香园肿瘤时间", date: "2026-10-21", titleRaw: "全球首创乙肝功能性治愈疗法获 FDA 批准上市",
  text: SOURCE, kind: "body" });
// The same source with more of the article after it: a 导读 of three sentences is within what it supports.
const LONGER = `${SOURCE}${"该研究的其余部分讨论了长期随访和停药后的持久性，以及与现有核苷类药物联用的方式。".repeat(4)}`;
const longInput = buildLeadInput({ sourceName: "丁香园肿瘤时间", date: "2026-10-21", titleRaw: "全球首创乙肝功能性治愈疗法获 FDA 批准上市",
  text: LONGER, kind: "body" });

test("the 导读 is shown its source, date, title and the reader text, the head of a long one", () => {
  assert.match(input, /^来源：丁香园肿瘤时间\n日期：2026-10-21\n标题：全球首创/);
  assert.match(input, /正文（全文）：\n B-Well|正文（全文）：\nB-Well/);
  const long = buildLeadInput({ sourceName: "S", titleRaw: "T", text: "字".repeat(FRONTIER_LEAD_LIMITS.input + 500), kind: "abstract" });
  assert.ok(long.endsWith("…") && long.includes("正文（摘要）"));
  assert.match(buildLeadInput({ sourceName: "S", titleRaw: "T", text: "post", kind: "body", post: true }), /正文（帖子）/);
});

test("the 导读's checks: one paragraph in Chinese, within the length, every number in the source; an empty answer is no 导读", () => {
  const good = "FDA 批准 GSK 的反义寡核苷酸 Bepirovirsen 与核苷（酸）类似物联用治疗慢性乙肝。B-Well 1 和 B-Well 2 合并数据显示，基线 HBsAg≤3000 IU/ml 人群功能性治愈率 19%（233/1220），安慰剂组 0%（0/614）。最常见不良事件为注射部位红斑、局部疼痛和一过性肝酶升高；该药已在中国申报上市。";
  assert.deepEqual(verifyLead({ lead_zh: good }, longInput).issues, []);
  assert.equal(verifyLead({ lead_zh: good }, longInput).output.lead_zh, good);
  assert.ok(verifyLead({ lead_zh: good.replace("19%", "27%") }, longInput).issues.some((issue) => issue.includes("27%")), "a number not in the source");
  assert.ok(verifyLead({ lead_zh: `${good}\n第二段。` }, longInput).issues.some((issue) => issue.includes("一段话")));
  assert.ok(verifyLead({ lead_zh: "- 决定：FDA 批准。\n- 依据：B-Well。" }, input).issues.length > 0, "points and headings are not a paragraph");
  assert.ok(verifyLead({ lead_zh: "字".repeat(FRONTIER_LEAD_LIMITS.chars + 1) }, longInput).issues.some((issue) => issue.includes("太长")));
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
  assert.match(calls[0].instructions, /一段话，不分点/);
  assert.equal(calls[0].instructions, FRONTIER_LEAD_INSTRUCTIONS, "an item of no known genre is written by the shared rules alone");
});

test("the 导读 is written by its genre: the shared rules first (the cached prefix), then one paragraph for the genre (ct-write W2)", async () => {
  for (const genre of FRONTIER_GENRES) {
    const instructions = frontierLeadInstructions(genre);
    assert.ok(instructions.startsWith(FRONTIER_LEAD_INSTRUCTIONS), genre);
    assert.ok(instructions.includes(`写法：${FRONTIER_LEAD_GUIDES[genre]}`), genre);
    // c2-style: the genre's two exemplars close it, said as what to learn from them.
    assert.ok(instructions.includes("只学顺序和句子的写法，不要照抄其中的事实、名称和措辞"), genre);
    for (const exemplar of FRONTIER_STYLE_CARDS[genre].exemplars) assert.ok(instructions.includes(exemplar.lead), genre);
  }
  assert.match(FRONTIER_LEAD_INSTRUCTIONS, /一句只讲一件事/, "the admitted banned moves are a rule of every 导读");
  assert.match(frontierLeadInstructions("social"), /一两句话/);
  assert.match(frontierLeadInstructions("approval"), /CHMP 的积极意见不等于批准/);
  assert.match(frontierLeadInstructions("paper", { briefed: true }), /另有「要点」/);
  assert.doesNotMatch(frontierLeadInstructions("paper"), /另有「要点」/);
  /** @type {any[]} */
  const calls = [];
  const editor = { async writeJson(/** @type {string} */ instructions) { calls.push(instructions); return { verification: "passed", output: { lead_zh: null }, error: null }; } };
  await frontierWriteLead(editor, { sourceName: "S", titleRaw: "T", text: SOURCE, kind: "body", genre: "approval", briefed: true });
  assert.equal(calls[0], frontierLeadInstructions("approval", { briefed: true }));
});

test("a 导读 is as long as its source supports: a one-line post gets a sentence or two, and above 要点 at most 160 characters", () => {
  // A 268-character X post supports about 80 Chinese characters; a long abstract the full 380.
  assert.equal(frontierLeadLimit("a".repeat(268)), FRONTIER_LEAD_LIMITS.min);
  assert.equal(frontierLeadLimit("a".repeat(5_000)), FRONTIER_LEAD_LIMITS.chars);
  assert.equal(frontierLeadLimit("字".repeat(200)), 200);
  const post = "Among adults initiating HIV treatment, doravirine, lamivudine and tenofovir was noninferior to dolutegravir for 48-week viral suppression, with less weight gain.";
  const postInput = buildLeadInput({ sourceName: "JAMA", titleRaw: "JAMA post", text: post, kind: "body", post: true });
  const padded = "在开始 HIV 治疗的成人中，多拉韦林三联方案在 48 周病毒抑制上不劣于多替拉韦方案，且体重增加更少。这条帖子没有给出样本量、置信区间和不良事件的具体数字，也没有说明研究的设计和随访时间，读者需要阅读原文才能判断其可靠性。";
  const fitted = verifyLead({ lead_zh: padded }, postInput);
  assert.deepEqual(fitted.issues, []);
  assert.equal(fitted.output.lead_zh, "在开始 HIV 治疗的成人中，多拉韦林三联方案在 48 周病毒抑制上不劣于多替拉韦方案，且体重增加更少。", "the sentences past what the post supports are cut");
  const long = "口服 PCSK9 抑制剂使主要心血管事件风险降低。".repeat(12);
  const longSource = buildLeadInput({ sourceName: "S", titleRaw: "T", text: "字".repeat(4_000), kind: "abstract" });
  assert.ok([...String(verifyLead({ lead_zh: long }, longSource, { briefed: true }).output.lead_zh)].length <= FRONTIER_LEAD_LIMITS.briefed);
  assert.ok([...String(verifyLead({ lead_zh: long }, longSource).output.lead_zh)].length > FRONTIER_LEAD_LIMITS.briefed);
});

test("a 导读's numbers are checked against the title and the text, not the date line the platform wrote (D-06)", () => {
  const dated = buildLeadInput({ sourceName: "来源 2026", date: "2026-10-21", titleRaw: "FDA 批准新药", text: `${"FDA 批准一款新药用于成人慢性乙肝。".repeat(6)}`, kind: "body" });
  assert.ok(verifyLead({ lead_zh: "FDA 于 2026 年 10 月 21 日批准一款新药用于成人慢性乙肝。" }, dated).issues.some((issue) => issue.includes("2026")));
  assert.deepEqual(verifyLead({ lead_zh: "FDA 批准一款新药用于成人慢性乙肝。" }, dated).issues, []);
});

test("an open-access PDF's text becomes the contract's paragraphs: headings marked, references and what follows cut", () => {
  const parsed = ["# A randomized trial of X", "", "Abstract text that opens the paper and runs on for a while.", "", "## Methods", "",
    "We enrolled 1,220 adults across 29 countries.\nRandomisation was 2:1.", "", "## Results", "", `${"Functional cure was 19%. ".repeat(60)}`, "",
    "## References", "", "1. Someone et al. A paper. 2024.", "", "## Supplementary", "", "More."].join("\n");
  const read = frontierFullTextParagraphs(parsed, { minChars: 200 });
  assert.ok(read);
  assert.equal(read.complete, true);
  const paragraphs = read.body.split("\n\n");
  assert.deepEqual(paragraphs.slice(0, 5), ["## A randomized trial of X", "Abstract text that opens the paper and runs on for a while.", "## Methods",
    "We enrolled 1,220 adults across 29 countries. Randomisation was 2:1.", "## Results"]);
  assert.ok(!read.body.includes("Someone et al.") && !read.body.includes("More."), "nothing after the references");
  assert.equal(frontierFullTextParagraphs("## Title\n\nToo short to be the article."), null);
  const long = frontierFullTextParagraphs(Array.from({ length: 40 }, (_, index) => `Paragraph ${index} ${"word ".repeat(40)}`).join("\n\n"), { limit: 1_000, minChars: 10 });
  assert.ok(long && long.body.length <= 1_000 && long.body.endsWith("word"), "cut at a paragraph end within the limit");
  assert.equal(long?.complete, false, "a text cut at the limit is not the whole paper");
});

test("a PDF's text without Markdown headings: references cut at their own line, the parser's empty mark gone, broken words rejoined", () => {
  // As the document parser wrote Frontiers in Neurology's PDF on 2026-10-22 (item 31132): plain heading lines, "[empty]" marks,
  // words broken at a line end with their hyphen, and the references after a line of their own.
  const results = "Efgartigimod was well tolerated; the response was suggesting a durable benefit, as developed below. ".repeat(30);
  const parsed = ["1 Introduction", "", "Myasthenia gravis is an autoimmune disorder that devel-oped over years, sug-gesting a long course.", "",
    "[empty] Frontiers in Neurology", "", "3 Results", "", results, "", "The real-world cohort was small.", "", "References", "",
    "1. Howard JF. Efgartigimod in generalized myasthenia gravis. Lancet Neurol. 2021.", "", "2. Someone. Another paper. 2024."].join("\n");
  const read = frontierFullTextParagraphs(parsed, { minChars: 200 });
  assert.ok(read);
  assert.ok(read.body.includes("disorder that developed over years, suggesting a long course"), "rejoined where the text writes the word whole");
  assert.ok(read.body.includes("The real-world cohort"), "a compound the text never writes whole keeps its hyphen");
  assert.ok(read.body.includes("\n\nFrontiers in Neurology\n\n") && !read.body.includes("[empty]"));
  assert.ok(!read.body.includes("Howard JF") && !read.body.includes("References"), "the references go from their own line");
  // Before the article has begun, a line reading References is not taken for its end.
  const early = frontierFullTextParagraphs(["References", "", results].join("\n"), { minChars: 200 });
  assert.ok(early?.body.startsWith("References"));
});

test("a PDF whose extraction lost its spaces is not a full text: the item keeps its abstract (Springer, 2026-10-22, item 7232)", () => {
  const glued = "Sixpatients(fivefemales,onemale;agerange15–44yearsatdiagnosis)withmacroadenomaswerecapturedinthisretrospectiveseries. ".repeat(20);
  const fine = "Six patients (five females, one male; age range 15–44 years at diagnosis) with macroadenomas were captured. ".repeat(20);
  assert.equal(frontierFullTextParagraphs(`${fine}\n\n${glued}`, { minChars: 200 }), null);
  assert.ok(frontierFullTextParagraphs(`${fine}\n\nHypertriglyceridemia and hypercholesterolemia were common.`, { minChars: 200 }));
  assert.ok(frontierGluedShare(glued) > 0.5 && frontierGluedShare(fine) === 0);
});

test("a translated section heading keeps its mark, and a paragraph that is not one never gains it", () => {
  assert.equal(verifyParagraph("方法", "## Methods"), "## 方法");
  assert.equal(verifyParagraph("## 结果", "## Results"), "## 结果");
  assert.equal(verifyParagraph("## 我们纳入了 1,220 名成人。", "We enrolled 1,220 adults."), "我们纳入了 1,220 名成人。");
});
