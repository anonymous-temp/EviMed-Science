import { describe, expect, it } from "vitest";
import { withoutPlatformText } from "./platformText";

describe("a message without what the platform wrote into it", () => {
  it("removes an injected block with everything it holds, and keeps the person's words", () => {
    expect(withoutPlatformText("整理研究定义\n\n<evimed-vcr-run>vcr-run-definition-1</evimed-vcr-run>")).toBe("整理研究定义");
    expect(withoutPlatformText("<evimed-vcr-brief>研究：…vcr_read…</evimed-vcr-brief>生成虚拟患者")).toBe("生成虚拟患者");
  });

  it("takes an unclosed block to the end of the text, and counts nested ones", () => {
    expect(withoutPlatformText("你好<evimed-brief>一段没有关上的说明")).toBe("你好");
    expect(withoutPlatformText("开头<evimed-brief>外<evimed-brief>内</evimed-brief>外</evimed-brief>结尾")).toBe("开头结尾");
  });

  it("returns a text with no tag as it came", () => {
    const text = "对照组中位 PFS < 4 个月吗？";
    expect(withoutPlatformText(text)).toBe(text);
    expect(withoutPlatformText("<b>加粗</b>")).toBe("<b>加粗</b>");
  });
});
