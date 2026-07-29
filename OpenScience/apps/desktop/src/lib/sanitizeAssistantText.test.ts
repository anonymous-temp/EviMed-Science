import { describe, expect, it } from "vitest";
import { sanitizeAssistantText } from "./sanitizeAssistantText";

describe("sanitizeAssistantText", () => {
  it("strips literal claim markers in either bracket style", () => {
    expect(sanitizeAssistantText("结果显著 [claim:CLM-006] 且稳定。")).toBe("结果显著  且稳定。");
    expect(sanitizeAssistantText("结果显著。【claim:CLM-006】")).toBe("结果显著。");
  });

  it("is case-insensitive and tolerant of whitespace and the fullwidth colon", () => {
    expect(sanitizeAssistantText("[ Claim : clm-006 ]")).toBe("");
    expect(sanitizeAssistantText("【claim：CLM-006】")).toBe("");
  });

  it("strips raw HTML comments, including multiline and still-streaming ones", () => {
    expect(sanitizeAssistantText("正文 <!-- claim:CLM-001 --> 继续")).toBe("正文  继续");
    expect(sanitizeAssistantText("a <!-- 多行\n注释 --> b")).toBe("a  b");
    expect(sanitizeAssistantText("正文 <!-- claim:CLM-0")).toBe("正文 ");
  });

  it("keeps citation-style bracket refs", () => {
    const text = "如文献 [1] 和 [2, 3] 所述。";
    expect(sanitizeAssistantText(text)).toBe(text);
  });

  it("leaves fenced code and inline code untouched", () => {
    const text =
      "示例：\n```html\n<!-- 页面骨架 -->\n<div/>\n```\n以及 `<!-- 行内 -->` 代码。";
    expect(sanitizeAssistantText(text)).toBe(text);
  });
});
