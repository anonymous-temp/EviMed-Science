import { describe, expect, it } from "vitest";
import { insightParts, readerOutline, readerParagraphs, shownText } from "./FrontierReader";

describe("the reader's paragraphs", () => {
  it("takes a full text's `## ` paragraphs as its section headings, in either language", () => {
    expect(readerParagraphs("## Methods\n\nWe enrolled 12,000 patients.\n\n## 结果\n\n主要终点下降。")).toEqual([
      { kind: "heading", text: "Methods" },
      { kind: "paragraph", runIn: null, text: "We enrolled 12,000 patients." },
      { kind: "heading", text: "结果" },
      { kind: "paragraph", runIn: null, text: "主要终点下降。" },
    ]);
  });

  it("keeps the text a heading runs straight on into as the paragraph under it", () => {
    expect(readerParagraphs("## Methods\nWe enrolled 12,000 patients.")).toEqual([
      { kind: "heading", text: "Methods" },
      { kind: "paragraph", runIn: null, text: "We enrolled 12,000 patients." },
    ]);
  });

  it("reads nothing else as a heading: a hash in the text, a deeper level, or a marker with no words", () => {
    for (const text of ["#1 open model in Agent Arena", "### Subsection", "##Methods", "C## is not a language", "##"]) {
      expect(readerParagraphs(text), text).toEqual([{ kind: "paragraph", runIn: null, text }]);
    }
  });

  it("runs an abstract paragraph's own heading in at its start, ASCII or full-width colon", () => {
    expect(readerParagraphs("Background: Oral PCSK9 inhibition lowers LDL.\n\n背景：口服 PCSK9 抑制可降低 LDL。\n\nConclusions and Relevance:  It worked.", { abstract: true })).toEqual([
      { kind: "paragraph", runIn: "Background:", text: " Oral PCSK9 inhibition lowers LDL." },
      { kind: "paragraph", runIn: "背景：", text: "口服 PCSK9 抑制可降低 LDL。" },
      { kind: "paragraph", runIn: "Conclusions and Relevance:", text: " It worked." },
    ]);
  });

  it("finds a run-in heading only in an abstract, only within forty characters, and only where it is a name", () => {
    expect(readerParagraphs("Background: not an abstract.")).toEqual([{ kind: "paragraph", runIn: null, text: "Background: not an abstract." }]);
    for (const text of [
      // The first colon is past forty characters: the paragraph is prose.
      "In this multicentre trial of oral inhibition we found: a lower risk.",
      // A sentence's end before the colon is no name.
      "HR 0.82 (95% CI: 0.75 to 0.90) favoured treatment.",
      // A link or a clock: no space after the colon.
      "https://example.org/trial was registered.",
      "10:30 was the median time.",
      // A heading with nothing after it.
      "Background:",
    ]) expect(readerParagraphs(text, { abstract: true }), text).toEqual([{ kind: "paragraph", runIn: null, text }]);
    // The forty characters are counted by character, Chinese included.
    const forty = "研".repeat(40);
    expect(readerParagraphs(`${forty}：正文。`, { abstract: true })[0]).toMatchObject({ runIn: `${forty}：` });
    expect(readerParagraphs(`${forty}研：正文。`, { abstract: true })[0]).toMatchObject({ runIn: null });
  });
});

describe("the 解读's citations", () => {
  const refs = [
    { n: 1, publicId: "item-a", title: "第一篇", source: "NEJM", at: null },
    { n: 2, publicId: "item-b", title: "第二篇", source: "FDA", at: null },
  ];

  it("turns each [n] that names a ref into that ref, and leaves the words between them as they are", () => {
    expect(insightParts("方向一致[1]，已受理[2]。", refs)).toEqual(["方向一致", refs[0], "，已受理", refs[1], "。"]);
    expect(insightParts("[2]开头，[1][2]相连", refs)).toEqual([refs[1], "开头，", refs[0], refs[1], "相连"]);
  });

  it("keeps an [n] that names no ref as plain text, never a dead link", () => {
    expect(insightParts("另见[3]，或 [x]、［1］。", refs)).toEqual(["另见[3]，或 [x]、［1］。"]);
    expect(insightParts("没有引用。", [])).toEqual(["没有引用。"]);
  });
});

describe("the reader's text structure (2026-10-23)", () => {
  it("sets a paragraph whose lines all start 「1.」「1、」「•」「-」 as a list, numbered or not, and keeps a decimal a number", () => {
    expect(readerParagraphs("1. 第一项\n2. 第二项\n\n3、第三项\n\n• 甲\n• 乙\n\n- one\n- two\n\n1.5 mg 每日一次")).toEqual([
      { kind: "list", ordered: true, start: 1, items: ["第一项", "第二项"] },
      { kind: "list", ordered: true, start: 3, items: ["第三项"] },
      { kind: "list", ordered: false, start: 1, items: ["甲", "乙"] },
      { kind: "list", ordered: false, start: 1, items: ["one", "two"] },
      { kind: "paragraph", runIn: null, text: "1.5 mg 每日一次" },
    ]);
  });

  it("sets the line that leads into two or more items as words, then the list; a mixed paragraph stays words", () => {
    expect(readerParagraphs("按信号来看，本次发布实现了：\n- 排名第 8\n- 没有问题")).toEqual([
      { kind: "paragraph", runIn: null, text: "按信号来看，本次发布实现了：" },
      { kind: "list", ordered: false, start: 1, items: ["排名第 8", "没有问题"] },
    ]);
    expect(readerParagraphs("开头一行\n- 只有一项")).toEqual([{ kind: "paragraph", runIn: null, text: "开头一行\n- 只有一项" }]);
  });

  it("sets a paragraph that starts 「> 」 as a quotation", () => {
    expect(readerParagraphs("> 引用的第一行\n> 第二行")).toEqual([{ kind: "quote", text: "引用的第一行\n第二行" }]);
  });

  it("draws an address on a paragraph of its own and up to two short lines before it as one source line", () => {
    expect(readerParagraphs("FDA 发布了新的指南。\n\n（美国FDA网站）\n\n原文链接：\n\nhttps://www.fda.gov/vaccines-blood-biologics/safety-availability-biologics/x")).toEqual([
      { kind: "paragraph", runIn: null, text: "FDA 发布了新的指南。" },
      { kind: "source", words: ["（美国FDA网站）", "原文链接："], url: "https://www.fda.gov/vaccines-blood-biologics/safety-availability-biologics/x" },
    ]);
  });

  it("takes no sentence into a source line: what ends like a sentence, or runs past thirty characters, stays a paragraph", () => {
    const blocks = readerParagraphs("这是一句完整的话。\n\n一段没有标点但是超过了三十个字符长度的说明文字一段没有标点但是超过\n\nhttps://nmpa.gov.cn/a");
    expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "paragraph", "source"]);
    expect(blocks[2]).toEqual({ kind: "source", words: [], url: "https://nmpa.gov.cn/a" });
  });

  it("drops the item's own address, and the short lines that name it, because the end of the article has it", () => {
    expect(readerParagraphs("正文一段。\n\n原文链接：\n\nhttp://www.nejm.org/doi/x/", { ownUrl: "https://nejm.org/doi/x" })).toEqual([
      { kind: "paragraph", runIn: null, text: "正文一段。" },
    ]);
  });

  it("lists a text's sections for its contents, with the ids its headings take, in the language on screen", () => {
    const body = { zh: "## 引言\n\n一。\n\n## 方法\n\n二。", original: "## Intro\n\nOne.", zhKind: "translation" as const, complete: true, source: "body" as const };
    expect(readerOutline(body, "zh", "p")).toEqual([{ id: "p-sec-1", text: "引言", level: 2 }, { id: "p-sec-2", text: "方法", level: 2 }]);
    expect(readerOutline(body, "original", "p")).toEqual([{ id: "p-sec-1", text: "Intro", level: 2 }]);
    expect(shownText({ ...body, original: null }, "original").showing).toBe("zh");
  });
});
