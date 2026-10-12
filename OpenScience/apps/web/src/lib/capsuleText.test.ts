import { describe, expect, it } from "vitest";
import { capsuleEntryPreview } from "./capsuleText";

describe("what a capsule preview shows of an entry", () => {
  it("names a shared method in its sharer's words and shows the paragraph saying what it is for, never the text written for the model", () => {
    const content = "# 证据分级先看设计再看偏倚\n\n先按研究设计定起点，再逐项降级。\n\nRe-grades each claim against its design before bias.\n\n## Steps\n1. Read the design.";
    expect(capsuleEntryPreview({ factKind: "method_preference", content })).toEqual({
      summary: "研究方法：证据分级先看设计再看偏倚",
      text: "先按研究设计定起点，再逐项降级。",
    });
  });

  it("shows any other entry whole under its kind", () => {
    expect(capsuleEntryPreview({ factKind: "writing_style", content: "结论先行，\n\n中文输出。" }))
      .toEqual({ summary: "写作偏好", text: "结论先行，\n\n中文输出。" });
  });

  it("shows only the opening paragraph of a method text that has no heading", () => {
    expect(capsuleEntryPreview({ factKind: "method_preference", content: "只看近五年的随机对照试验。\n\nThe body." }))
      .toEqual({ summary: "研究方法", text: "只看近五年的随机对照试验。" });
  });
});
