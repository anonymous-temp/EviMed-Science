import { describe, expect, it } from "vitest";
import { insightParts, readerParagraphs } from "./FrontierReader";

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
