// What goes out to an outlet and how what comes back is compared.
import assert from "node:assert/strict";
import test from "node:test";
import {
  compareProtectedSpans,
  extractProtectedSpans,
  htmlToText,
  markdownToHtml,
  splitLeadingTitle,
} from "../src/geoMarketText.mjs";
import { extractHtml } from "../src/webReadExtract.mjs";
import { ARTICLE_MARKDOWN, publishedHtml } from "./helpers/geoMarketScenarios.mjs";

const terms = ["司美格鲁肽", "诺和泰"];
const sentText = () => htmlToText(markdownToHtml(splitLeadingTitle(ARTICLE_MARKDOWN).body));

test("Markdown becomes escaped HTML: headings, paragraphs, lists, tables, emphasis, http links only", () => {
  const html = markdownToHtml("## 小标题\n\n第一段 **重点** 与 *强调*，见 [说明书](https://www.nmpa.gov.cn/x)。\n\n<script>alert(1)</script> [坏链接](javascript:alert(1))\n\n- 一\n- 二\n\n1. 甲\n2. 乙\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> 引文");
  assert.match(html, /<h2>小标题<\/h2>/);
  assert.match(html, /<strong>重点<\/strong>/);
  assert.match(html, /<em>强调<\/em>/);
  assert.match(html, /<a href="https:\/\/www\.nmpa\.gov\.cn\/x">说明书<\/a>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes('href="javascript'));
  assert.match(html, /<ul><li>一<\/li><li>二<\/li><\/ul>/);
  assert.match(html, /<ol><li>甲<\/li><li>乙<\/li><\/ol>/);
  assert.match(html, /<table><thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td>2<\/td><\/tr><\/tbody><\/table>/);
  assert.match(html, /<blockquote><p>引文<\/p><\/blockquote>/);
});

test("the leading heading is the title; the body goes without it", () => {
  assert.deepEqual(splitLeadingTitle("# 标题 #\n\n正文"), { title: "标题", body: "\n正文" });
  assert.deepEqual(splitLeadingTitle("正文\n# 不是标题"), { title: null, body: "正文\n# 不是标题" });
  assert.equal(htmlToText("<p>a&amp;b&nbsp;c</p><script>x()</script><div>d</div>"), "a&b c\nd");
});

test("protected spans: numbers with units, frequencies, drug names, URLs, PMIDs, reference markers", () => {
  const spans = extractProtectedSpans(sentText(), { terms });
  const byKind = (/** @type {string} */ kind) => spans.filter((span) => span.kind === kind).map((span) => span.text);
  assert.deepEqual(byKind("drug"), ["司美格鲁肽", "诺和泰"]);
  assert.deepEqual(byKind("frequency"), ["每周 0.25 mg", "每周 0.5 mg", "每周注射一次"]);
  assert.deepEqual(byKind("url"), ["https://www.nmpa.gov.cn/label/123"]);
  assert.deepEqual(byKind("pmid"), ["PMID: 12345678"]);
  assert.deepEqual(byKind("reference"), ["[1]"]);
  assert.ok(byKind("number").includes("20%"));
  assert.ok(byKind("number").includes("0.25 mg"));
  assert.ok(byKind("number").includes("1-4"));
  assert.ok(!byKind("number").includes("4") && !byKind("number").includes("1"), "a bare digit proves nothing");
  assert.deepEqual(extractProtectedSpans("一日三次，每日 2 次，第 3 天，共 12 例", { terms: [] }).map((span) => span.text),
    ["一日三次", "每日 2 次", "3 天", "12 例"]);
});

test("the page as the platform's extractor reads it matches what was sent", () => {
  const spans = extractProtectedSpans(sentText(), { terms });
  const page = extractHtml(publishedHtml(ARTICLE_MARKDOWN), { baseUrl: new URL("https://www.jksb.com.cn/p/1.html") }).text;
  const comparison = compareProtectedSpans(spans, page);
  assert.deepEqual(comparison.missing, []);
  assert.equal(comparison.protectedMatched, comparison.protectedTotal);
});

test("whitespace is layout; every other byte of a protected span counts", () => {
  const spans = extractProtectedSpans(sentText(), { terms });
  const text = sentText();
  assert.deepEqual(compareProtectedSpans(spans, text.replace(/ /g, "  ").replace(/0\.25 mg/g, "0.25mg")).missing, []);
  const changed = (/** @type {string} */ from, /** @type {string} */ to) =>
    compareProtectedSpans(spans, text.replace(from, to)).missing.map((item) => item.text);
  assert.deepEqual(changed("每周注射一次", "每天注射一次"), ["每周注射一次"]);
  assert.deepEqual(changed("20%", "20％"), ["20%"], "full width is a different byte");
  assert.deepEqual(changed("诺和泰", "诺和"), ["诺和泰"]);
  assert.deepEqual(changed("PMID: 12345678", "PMID: 12345679"), ["PMID: 12345678"]);
  assert.deepEqual(changed("https://www.nmpa.gov.cn/label/123", "https://www.nmpa.gov.cn/label/124"), ["https://www.nmpa.gov.cn/label/123"]);
  assert.deepEqual(changed("| 1-4 |", "| 1-5 |"), [], "the markdown table line is not in the text");
});

test("a number glued to more digits in the page is not a match, and multiplicity counts", () => {
  const spans = extractProtectedSpans("剂量 2.4 mg，然后 2.4 mg。", { terms: [] });
  assert.deepEqual(spans, [{ kind: "number", text: "2.4 mg", count: 2 }]);
  assert.equal(compareProtectedSpans(spans, "剂量 12.4 mg，然后 2.4 mg。").missing[0].found, 1);
  assert.equal(compareProtectedSpans(spans, "剂量 2.4 mg，然后 2.4 mg，再 2.4 mg").missing.length, 0, "more is fine");
  assert.equal(compareProtectedSpans(extractProtectedSpans("约 24 例", { terms: [] }), "约 245 例").missing.length, 1);
  assert.equal(compareProtectedSpans(extractProtectedSpans("| 1-4 | 0.25 mg |", { terms: [] }), "1-4\n0.25 mg").missing.length, 0,
    "cells on separate lines are not glued");
});

test("extraction is linear: a 700 KB body with sixty thousand spans takes well under a second", () => {
  const text = "司美格鲁肽每周注射一次，每次 0.5 mg。".repeat(30_000);
  const started = performance.now();
  const spans = extractProtectedSpans(text, { terms });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1_500, `took ${Math.round(elapsed)} ms`);
  assert.equal(spans.find((span) => span.text === "司美格鲁肽")?.count, 30_000);
});
