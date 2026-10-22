// The reader's text, settled (frontierReaderTidy.mjs, 2026-10-22): structured abstracts laid out by section in code, the
// model's verdict on which paragraphs are not the article's checked by code and applied only to the text it was made for.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  FRONTIER_TIDY_INSTRUCTIONS, FRONTIER_TIDY_LIMITS, buildTidyInput, frontierAbstractLayout, frontierSettledParagraphs, frontierTidyBasis,
  frontierTidyVerdict, readTidyAnswer,
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

test("the model's answer is checked by code: numbers it was shown, and enough of the text kept", () => {
  const paragraphs = ["By Tara Bannow", "Tara covers health care.", "The premium rose 9% to $7,471.".repeat(4), "Advertisement", "Small firms rose more.".repeat(3)];
  assert.deepEqual(readTidyAnswer({ drop: [3, 0, 1, 1] }, paragraphs, 5), { drop: [0, 1, 3], refused: null });
  assert.deepEqual(readTidyAnswer({ drop: [] }, paragraphs, 5), { drop: [], refused: null });
  assert.deepEqual(readTidyAnswer({ drop: [5] }, paragraphs, 5), { drop: [], refused: "answer_invalid" }, "a paragraph it was not shown");
  assert.deepEqual(readTidyAnswer({ drop: [4] }, paragraphs, 4), { drop: [], refused: "answer_invalid" }, "beyond the paragraphs judged");
  assert.deepEqual(readTidyAnswer({ drop: ["1"] }, paragraphs, 5), { drop: [], refused: "answer_invalid" });
  assert.deepEqual(readTidyAnswer(null, paragraphs, 5), { drop: [], refused: "answer_invalid" });
  assert.deepEqual(readTidyAnswer({ drop: [0, 1, 2, 3, 4] }, paragraphs, 5), { drop: [], refused: "too_much" });
  assert.deepEqual(readTidyAnswer({ drop: [2, 4] }, paragraphs, 5), { drop: [], refused: "too_much" }, `less than ${FRONTIER_TIDY_LIMITS.keepShare} of the text kept`);
});

test("what one call is shown: title, source, the paragraphs, a long one by its head and tail; a short text is not worth a call", () => {
  const long = `${"头".repeat(200)}${"尾".repeat(100)}`;
  const built = buildTidyInput({ title: "标题", source: "来源", paragraphs: ["第一段文字。".repeat(10), long, "第三段。"] });
  assert.ok(built);
  const input = JSON.parse(built.content);
  assert.deepEqual([input.title, input.source, input.p.length, built.judged], ["标题", "来源", 3, 3]);
  assert.equal(input.p[1], `${"头".repeat(FRONTIER_TIDY_LIMITS.headChars)} … ${"尾".repeat(FRONTIER_TIDY_LIMITS.tailChars)}`);
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
  const editor = { async callJson(/** @type {any[]} */ messages, /** @type {any} */ limits) { calls.push({ messages, limits }); return { drop: [0] }; } };
  const paragraphs = ["Skip to content", "A paragraph of the article that is long enough to be read as prose by the editor.".repeat(3)];
  assert.deepEqual(await frontierTidyVerdict(editor, { title: "T", source: "S", paragraphs }), { drop: [0], refused: null, called: true });
  assert.equal(calls[0].messages[0].content, FRONTIER_TIDY_INSTRUCTIONS);
  assert.ok(calls[0].limits.maxTokens > 0 && calls[0].limits.timeoutMs > 0);
  assert.deepEqual(await frontierTidyVerdict(editor, { paragraphs: ["Short.", "Also short."] }), { drop: [], refused: null, called: false });
  assert.equal(calls.length, 1);
});
