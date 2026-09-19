import assert from "node:assert/strict";
import test from "node:test";

import { KB_CHUNK_TARGET_TOKENS, chunkDocument, documentTerms, estimateTokens, trigramTerms, tsqueryLiteral, tsvectorLiteral } from "../src/kbChunker.mjs";
import { searchTokens } from "../src/memoryRecallPolicy.mjs";

test("a page map cuts the document page by page, and every chunk is an exact slice", () => {
  const text = "第一页：抗凝治疗概述。\n第二页：利伐沙班 15 mg 每日一次。\n第三页：出血处理。";
  const pageMap = [
    { page: 1, start: 0, end: 12, status: "ok" },
    { page: 2, start: 12, end: 33, status: "ok" },
    { page: 3, start: 33, end: 33, status: "ocr_failed" },
    { page: 4, start: 33, end: text.length, status: "ok" },
  ];
  const chunks = chunkDocument({ text, pageMap, title: "房颤指南" });
  assert.deepEqual(chunks.map((chunk) => [chunk.page, text.slice(chunk.start, chunk.end)]), [
    [1, "第一页：抗凝治疗概述。\n"],
    [2, "第二页：利伐沙班 15 mg 每日一次。\n"],
    [4, "第三页：出血处理。"],
  ], "an empty page has nothing to index");
  assert.equal(chunks[0].prefix, "房颤指南");
  assert.deepEqual(chunks.map((chunk) => chunk.ordinal), [0, 1, 2]);
});

test("without pages, headings start chunks and carry their path into the prefix", () => {
  const text = "# 抗凝治疗\n\n总述段落。\n\n## 剂量\n\n利伐沙班 20 mg。\n\n## 出血\n\n停药并评估。\n";
  const chunks = chunkDocument({ text, title: "指南" });
  assert.deepEqual(chunks.map((chunk) => chunk.prefix), ["指南 › 抗凝治疗", "指南 › 抗凝治疗 › 剂量", "指南 › 抗凝治疗 › 出血"]);
  assert.ok(text.slice(chunks[1].start, chunks[1].end).startsWith("## 剂量"));
  assert.ok(text.slice(chunks[1].start, chunks[1].end).includes("利伐沙班 20 mg。"));
});

test("a long section is cut near the target at sentence ends, and a table is never cut", () => {
  const sentence = "利伐沙班用于非瓣膜性房颤的卒中预防，剂量按肾功能调整。";
  const text = `# 章节\n\n${sentence.repeat(120)}\n\n${Array.from({ length: 400 }, (_, row) => `| 行${row} | 数值${row} |`).join("\n")}\n`;
  const chunks = chunkDocument({ text, title: "t" });
  const paragraphChunks = chunks.filter((chunk) => !text.slice(chunk.start, chunk.end).includes("| 行"));
  assert.ok(paragraphChunks.length >= 2, "the long paragraph was cut");
  for (const chunk of paragraphChunks) {
    const slice = text.slice(chunk.start, chunk.end);
    assert.ok(estimateTokens(slice) <= KB_CHUNK_TARGET_TOKENS + 40, `a chunk of ${estimateTokens(slice)} tokens`);
  }
  assert.ok(paragraphChunks.every((chunk) => text.slice(chunk.start, chunk.end).trimEnd().endsWith("。")), "cut at sentence ends");
  assert.ok(text.slice(paragraphChunks[0].start, paragraphChunks[0].end).startsWith("# 章节"), "the heading joins its section's first piece");
  const tables = chunks.filter((chunk) => text.slice(chunk.start, chunk.end).includes("| 行"));
  assert.equal(tables.length, 1, "the table stays whole even past the target");
  assert.ok(text.slice(tables[0].start, tables[0].end).includes("| 行0 |") && text.slice(tables[0].start, tables[0].end).includes("| 行399 |"));
});

test("a chunk's terms are the recall tokenizer's, all of them, not its first 64", () => {
  const text = "利伐沙班阿哌沙班达比加群依度沙班华法林普通肝素低分子肝素磺达肝癸钠比伐芦定阿加曲班替格瑞洛氯吡格雷普拉格雷"
    + "阿司匹林双嘧达莫西洛他唑贝前列素钠尿激酶链激酶阿替普酶瑞替普酶替奈普酶 rivaroxaban apixaban eGFR NOAC";
  const terms = documentTerms(text);
  // One call would stop at 64; the windows reach the end of the run.
  assert.ok(terms.size > 64, `only ${terms.size} terms`);
  for (const term of ["利伐", "沙班", "阿加", "曲班", "rivaroxaban", "apixaban", "egfr", "noac"]) assert.ok(terms.has(term), term);
  // A question and a chunk are cut the same way: every pair and every word a
  // question has, a chunk that contains it has too. (A whole CJK run is a term
  // only as long as the run it came from, so the question's 「阿加曲班」 meets
  // the chunk through its pairs.)
  for (const term of searchTokens("阿加曲班 NOAC").filter((term) => term.length === 2 || /^[a-z]/.test(term))) assert.ok(terms.has(term), term);
});

test("the literals PostgreSQL reads are quoted, positioned and bounded", () => {
  assert.equal(tsvectorLiteral("剂量 剂量 mg"), "'剂量':1,2 'mg':3");
  // Punctuation never reaches a term, so a quote cannot break the literal.
  assert.equal(tsvectorLiteral("o'brien sglt2"), "'brien':1 'sglt2':2");
  assert.equal(tsqueryLiteral("利伐沙班 15mg"), "'利伐沙班' | '15mg' | '利伐' | '伐沙' | '沙班'");
  assert.equal(tsqueryLiteral("?"), "");
  assert.deepEqual(trigramTerms("Rivaroxiban 与 NOAC 的 eGFR"), ["rivaroxiban", "noac", "egfr"]);
});
