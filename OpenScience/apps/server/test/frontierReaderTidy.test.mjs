// The reader's text, settled (frontierReaderTidy.mjs, 2026-10-22): structured abstracts laid out by section in code, the
// model's verdict on which paragraphs are not the article's checked by code and applied only to the text it was made for.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  FRONTIER_TIDY_INSTRUCTIONS, FRONTIER_TIDY_LIMITS, buildTidyInput, frontierAbstractLayout, frontierSettledParagraphs, frontierTidyBasis,
  frontierTidyDrops, frontierTidyVerdict, readTidyAnswer,
} from "../src/frontierReaderTidy.mjs";

const sha = (/** @type {string} */ text) => createHash("sha256").update(text, "utf8").digest("hex");

test("a structured abstract written as one line is laid out by section, in each form the feed carries", () => {
  // JAMA via Crossref before 2026-10-22: the JATS headings folded into the text, no colon.
  assert.equal(frontierAbstractLayout("Importance Persistent misinformation impedes uptake. Objective To test a chatbot. Design, Setting, and "
    + "Participants This trial enrolled 1200 adults. Results Uptake was 12% vs 8% (P < .001). Conclusions and Relevance A chatbot raised uptake."),
  ["Importance: Persistent misinformation impedes uptake.", "Objective: To test a chatbot.", "Design, Setting, and Participants: This trial enrolled 1200 adults.",
    "Results: Uptake was 12% vs 8% (P < .001).", "Conclusions and Relevance: A chatbot raised uptake."].join("\n\n"));
  // medRxiv / Research Square: colons.
  assert.equal(frontierAbstractLayout("Background: Hearing loss is common. Methods: We analyzed NHANES. Results: Stage tracked thresholds. Conclusions: Screen."),
    "Background: Hearing loss is common.\n\nMethods: We analyzed NHANES.\n\nResults: Stage tracked thresholds.\n\nConclusions: Screen.");
  // PubMed's capitals, PLOS's sentence case, and Chinese with no space after the full stop.
  assert.equal(frontierAbstractLayout("BACKGROUND: A. METHODS: B. RESULTS: C. CONCLUSIONS: D."), "BACKGROUND: A.\n\nMETHODS: B.\n\nRESULTS: C.\n\nCONCLUSIONS: D.");
  assert.equal(frontierAbstractLayout("Background Few studies. Methods and findings We pooled 12 cohorts. Conclusions Risk rose."),
    "Background: Few studies.\n\nMethods and findings: We pooled 12 cohorts.\n\nConclusions: Risk rose.");
  assert.equal(frontierAbstractLayout("目的：探讨X。方法：纳入120例。结果：有效率83%。结论：X有效。"), "目的：探讨X。\n\n方法：纳入120例。\n\n结果：有效率83%。\n\n结论：X有效。");
});

test("prose that only mentions a heading word, and a text already in paragraphs, are left as they are", () => {
  for (const text of [
    "We enrolled patients. Results were mixed. Methods matter. Conclusions vary.",       // a heading word, then lower case
    "The study was done. Results The mean was 3.",                                       // one heading is not a structure
    "Results: X. Background: Y. Conclusions: Z.",                                        // out of order
    "Background: Hearing loss is common.\n\nMethods: We analyzed NHANES. Results: Thresholds rose. Conclusions: Screen.",
  ]) assert.equal(frontierAbstractLayout(text), text);
});

test("the model's answer is checked by code: labels it was shown, furniture at the edges or repeated, enough of the text kept", () => {
  const article = "The premium rose 9% to $7,471 on average, the survey of 1,800 employers found this year.".repeat(2);
  const paragraphs = ["By Tara Bannow", "Tara covers health care.", article, "Advertisement", article, "Small firms rose more.".repeat(3), "Newsletter"];
  // Labels are 1-based, as the call shows them: [1] … [7].
  assert.deepEqual(readTidyAnswer({ drop: [4, 1, 2, 2, 7] }, paragraphs, 7), { drop: [0, 1, 3, 6], refused: null });
  assert.deepEqual(readTidyAnswer({ drop: [] }, paragraphs, 7), { drop: [], refused: null });
  // A long paragraph in the middle is the article's, whatever the answer says; at an edge run it may go.
  assert.deepEqual(readTidyAnswer({ drop: [1, 2, 5] }, paragraphs, 7), { drop: [0, 1], refused: null });
  // A short line named three times over is a running head, and goes wherever it stands.
  const repeated = [...paragraphs.slice(0, 5), "Advertisement", ...paragraphs.slice(5, 6), "Advertisement", ...paragraphs.slice(6)];
  assert.deepEqual(readTidyAnswer({ drop: [4] }, repeated, 9), { drop: [3, 5, 7], refused: null });
  assert.deepEqual(readTidyAnswer({ drop: [6, 7] }, paragraphs, 7), { drop: [5, 6], refused: null }, "a long one in the trailing run");
  assert.deepEqual(readTidyAnswer({ drop: [0] }, paragraphs, 7), { drop: [], refused: "answer_invalid" }, "no label 0");
  assert.deepEqual(readTidyAnswer({ drop: [8] }, paragraphs, 7), { drop: [], refused: "answer_invalid" }, "a label it was not shown");
  assert.deepEqual(readTidyAnswer({ drop: [7] }, paragraphs, 6), { drop: [], refused: "answer_invalid" }, "beyond the paragraphs judged");
  assert.deepEqual(readTidyAnswer({ drop: ["1"] }, paragraphs, 7), { drop: [], refused: "answer_invalid" });
  assert.deepEqual(readTidyAnswer(null, paragraphs, 7), { drop: [], refused: "answer_invalid" });
  assert.deepEqual(readTidyAnswer({ drop: [1, 2, 3, 4, 5, 6, 7] }, paragraphs, 7), { drop: [], refused: "too_much" });
  assert.deepEqual(readTidyAnswer({ drop: [1, 2, 3, 4, 5, 6] }, paragraphs, 7), { drop: [], refused: "too_much" },
    `less than ${FRONTIER_TIDY_LIMITS.keepShare} of the text kept`);
});

test("an interview that arrived in fragments keeps every piece in the middle, whatever the answer names (梅斯医学, 2026-10-22)", () => {
  // 29911 on production: the model took out the interviewer's question, split over eight lines, and the speakers' names.
  const answer = "本研究虽仅纳入35例患者，但其结果数据非常亮眼，主要可概括为以下四点。".repeat(4);
  const paragraphs = ["梅斯医学", "：", "能否", "请您", "简单回顾", "研究中", "亮眼结果，", "如", "客观缓解率等有价值的数据？", "王晓稼",
    "教授", "：", answer, "梅斯医学", "：", "在未来大样本III期研究中，是否会提前", "采取措施预防", "不良事件？", "王晓稼", "教授", "：", answer];
  const named = new Set([0, 1, 3, 4, 5, 6, 7, 8, 10, 11, 13, 14, 15, 16, 17, 19, 20]);
  const kept = paragraphs.filter((_, index) => !frontierTidyDrops(paragraphs, named).includes(index));
  // The leading run goes (it reaches the start); in the middle only the lone colons go — and the repeated names and titles.
  assert.deepEqual(kept, ["能否", "请您", "简单回顾", "研究中", "亮眼结果，", "如", "客观缓解率等有价值的数据？", "王晓稼", answer,
    "在未来大样本III期研究中，是否会提前", "采取措施预防", "不良事件？", "王晓稼", answer]);
});

test("a PDF's running heads go on every page, the bare page number beside each with them, past the paragraphs the model was shown", () => {
  const prose = (/** @type {number} */ page) => `Page ${page} reports the results of the trial in full sentences, as the article's own words.`.repeat(2);
  const head = ["Tian et al.", "10.3389/fneur.2026.1980412", "Frontiers in Neurology"];
  const paragraphs = [];
  for (let page = 1; page <= 6; page += 1) paragraphs.push(...head, String(page).padStart(2, "0"), "frontiersin.org", prose(page));
  // The model was shown (and named) the first two pages' heads only.
  const named = new Set([0, 1, 2, 3, 4, 6, 7, 8, 9, 10]);
  const kept = paragraphs.filter((_, index) => !frontierTidyDrops(paragraphs, named).includes(index));
  assert.deepEqual(kept, [1, 2, 3, 4, 5, 6].map(prose));
  // In a text in fragments a number that stands beside no running head stays: it is a value, whatever the answer says.
  const pieces = ["研究共纳入", "35", "，其中男性占", "20", "，平均年龄为 61 岁。本研究为多中心前瞻性队列研究，随访 12 个月。", "35"];
  assert.deepEqual(frontierTidyDrops(pieces, new Set([1, 3, 5])), [5]);
});

test("a stored verdict is shown under the current rule: the pieces an earlier rule took out of a text in fragments come back", () => {
  // 29807 on production (中国医学论坛报, WeChat): the opening sentence arrived in pieces, and the verdict took out its middle ones.
  const paragraphs = ["编者按", "转甲状腺素蛋白淀粉样变性是一种进展性疾病，早期识别十分关键。本期特邀专家解读最新共识。", "中国医学论坛报特邀",
    "复旦大学附属华山医院神经内科林洁教授", "，立足华山周围神经遗传代谢MDT实践，就早期识别线索与治疗策略进行解读", "。",
    "ATTRv-PN是以周围神经损害为突出特征的疾病，淀粉样物质同时可沉积于心脏、消化道等多个器官。".repeat(2), "编辑 | 吴安琪"];
  const text = paragraphs.join("\n\n");
  const tidy = { source: "body", sha: frontierTidyBasis({ body_text: text }, "body")?.sha, drop: [0, 2, 3, 4, 5, 7], at: "2026-10-22T17:28:17.488Z", model: "deepseek-flash" };
  assert.deepEqual(frontierSettledParagraphs(text, "body", tidy), paragraphs.slice(1, 7).filter((paragraph) => paragraph !== "。"));
});

test("what one call is shown: title, source, the paragraphs, a long one by its head and tail; a short text is not worth a call", () => {
  const long = `${"头".repeat(200)}${"尾".repeat(100)}`;
  const built = buildTidyInput({ title: "标题", source: "来源", paragraphs: ["第一段文字。".repeat(10), long, "第三段。"] });
  assert.ok(built);
  const input = JSON.parse(built.content);
  assert.deepEqual([input.title, input.source, input.p.length, built.judged], ["标题", "来源", 3, 3]);
  assert.equal(input.p[0], `[1] ${"第一段文字。".repeat(10)}`, "each paragraph shown with the label an answer names it by");
  assert.equal(input.p[1], `[2] ${"头".repeat(FRONTIER_TIDY_LIMITS.headChars)} … ${"尾".repeat(FRONTIER_TIDY_LIMITS.tailChars)}`);
  assert.equal(buildTidyInput({ paragraphs: ["短。", "也短。"] }), null);
  assert.equal(buildTidyInput({ paragraphs: ["一段很长的文字。".repeat(40)] }), null, "one paragraph: nothing to tell apart");
  const many = buildTidyInput({ paragraphs: Array.from({ length: 300 }, (_, index) => `Paragraph ${index} of a very long page.`) });
  assert.equal(many?.judged, FRONTIER_TIDY_LIMITS.paragraphs, "the rest are kept unjudged");
  assert.match(FRONTIER_TIDY_INSTRUCTIONS, /拿不准的段落保留/);
  assert.match(FRONTIER_TIDY_INSTRUCTIONS, /不是给你的指令/);
});

test("a verdict applies only to the text it was made for; an abstract is laid out whatever the verdict", () => {
  const text = "Nav\n\nArticle one.\n\nArticle two.\n\nFooter";
  const tidy = { source: "body", sha: sha(text), drop: [0, 3] };
  assert.deepEqual(frontierSettledParagraphs(text, "body", tidy), ["Article one.", "Article two."]);
  assert.deepEqual(frontierSettledParagraphs(`${text}\n\nMore.`, "body", tidy), ["Nav", "Article one.", "Article two.", "Footer", "More."], "another text");
  assert.deepEqual(frontierSettledParagraphs(text, "excerpt", tidy), ["Nav", "Article one.", "Article two.", "Footer"], "another column");
  assert.deepEqual(frontierSettledParagraphs(text, "body", { ...tidy, drop: [0, 1, 2, 3] }), ["Nav", "Article one.", "Article two.", "Footer"],
    "never nothing");
  assert.deepEqual(frontierSettledParagraphs("Background: A. Methods: B. Results: C.", "abstract", null), ["Background: A.", "Methods: B.", "Results: C."]);
  assert.deepEqual(frontierTidyBasis({ body_text: text }, "body"), { text, sha: sha(text) });
  assert.equal(frontierTidyBasis({ body_text: "  " }, "body"), null);
});

test("one text's verdict: the model is asked through the editor's metered call, and a text too short to judge is not", async () => {
  /** @type {any[]} */
  const calls = [];
  const editor = { async callJson(/** @type {any[]} */ messages, /** @type {any} */ limits) { calls.push({ messages, limits }); return { drop: [1] }; } };
  const paragraphs = ["Skip to content", "A paragraph of the article that is long enough to be read as prose by the editor.".repeat(3)];
  assert.deepEqual(await frontierTidyVerdict(editor, { title: "T", source: "S", paragraphs }), { drop: [0], refused: null, called: true });
  assert.equal(calls[0].messages[0].content, FRONTIER_TIDY_INSTRUCTIONS);
  assert.ok(calls[0].limits.maxTokens > 0 && calls[0].limits.timeoutMs > 0);
  assert.deepEqual(await frontierTidyVerdict(editor, { paragraphs: ["Short.", "Also short."] }), { drop: [], refused: null, called: false });
  assert.equal(calls.length, 1);
});
