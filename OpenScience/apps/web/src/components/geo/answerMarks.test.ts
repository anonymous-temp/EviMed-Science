import { describe, expect, it } from "vitest";
import { markAnswer } from "./answerMarks";

describe("markAnswer", () => {
  it("bolds our names and marks a wrong sentence where it stands, in its paragraph", () => {
    const { paragraphs, unplaced } = markAnswer("恶心很常见。\n\n以玛仕度肽为例，它需要每天注射一次，之后逐步加量。", {
      wrong: ["它需要每天注射一次。"],
      ours: ["玛仕度肽"],
    });
    expect(unplaced).toEqual([]);
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0].wrong).toEqual([]);
    expect(paragraphs[1].wrong).toEqual(["它需要每天注射一次。"]);
    expect(paragraphs[1].segments).toEqual([
      { text: "以", ours: false, wrong: null },
      { text: "玛仕度肽", ours: true, wrong: null },
      { text: "为例，", ours: false, wrong: null },
      { text: "它需要每天注射一次", ours: false, wrong: 0 },
      { text: "，之后逐步加量。", ours: false, wrong: null },
    ]);
  });

  it("returns a wrong sentence the text does not contain, rather than dropping it", () => {
    const { paragraphs, unplaced } = markAnswer("一段回答。", { wrong: ["不在原文里的一句"], ours: [] });
    expect(paragraphs[0].wrong).toEqual([]);
    expect(unplaced).toEqual(["不在原文里的一句"]);
  });

  it("keeps a name inside a wrong sentence bold and the longest name first", () => {
    const { paragraphs } = markAnswer("玛仕度肽注射液每天一次。", { wrong: ["玛仕度肽注射液每天一次"], ours: ["玛仕度肽", "玛仕度肽注射液"] });
    expect(paragraphs[0].segments).toEqual([
      { text: "玛仕度肽注射液", ours: true, wrong: 0 },
      { text: "每天一次", ours: false, wrong: 0 },
      { text: "。", ours: false, wrong: null },
    ]);
  });
});
