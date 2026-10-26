import { describe, expect, it } from "vitest";
import { factItems, factRowSummary } from "./memoryItems";
import { fileStatements, fileSummary, fileTopic, isFileMemory, isProfileLine, memoryText } from "./memoryNative";
import { nativeFile, nativeProfile, nativeProfileLine } from "./__fixtures__/memoryProfiles";

describe("a memory kept as a file", () => {
  it("is a file when it has no document and a line when it has one", () => {
    expect(isFileMemory(nativeFile("回答结构", "- x"))).toBe(true);
    expect(isProfileLine(nativeFile("回答结构", "- x"))).toBe(false);
    expect(isProfileLine(nativeProfileLine("临床药师"))).toBe(true);
    expect(isFileMemory(nativeProfileLine("临床药师"))).toBe(false);
  });

  it("names its topic in words and says its statements without bullets or heading marks", () => {
    expect(fileTopic(nativeFile("meta_analysis_method", "- x"))).toBe("meta analysis method");
    expect(fileTopic(nativeFile("回答结构", "- x"))).toBe("回答结构");
    expect(fileStatements("# 订单服务重构\n领域：后端架构\n## 目标\n- 把订单拆成独立服务。\n1. 周五前出方案。")).toEqual(["领域：后端架构", "把订单拆成独立服务。", "周五前出方案。"]);
    expect(fileSummary(nativeFile("回答结构", "- 先给结论，再给依据。\n- 表格不超过五列。"))).toBe("先给结论，再给依据；表格不超过五列");
    // A file with only a heading says the heading rather than nothing.
    expect(fileStatements("# 只有标题")).toEqual(["只有标题"]);
  });

  it("is listed by its topic with its statements under it; a line of the profile is listed as the sentence it is", () => {
    const items = factItems(nativeProfile.records, []);
    const file = items.find((item) => item.kind === "record" && item.record.summary === "回答结构");
    const line = items.find((item) => item.kind === "record" && item.record.value === "所在科室是临床药学部。");
    expect(file?.text).toBe("回答结构");
    expect(file && factRowSummary(file)).toBe("先给结论，再给依据；表格不超过五列");
    expect(line?.text).toBe("所在科室是临床药学部。");
    expect(line && factRowSummary(line)).toBeUndefined();
  });

  it("edits a file from its whole text, and a sentence from the sentence", () => {
    expect(memoryText(nativeFile("回答结构", "- 先给结论。"))).toBe("- 先给结论。");
    expect(memoryText(nativeProfileLine("所在科室是临床药学部。"))).toBe("所在科室是临床药学部。");
  });

  it("files itself under the same headings as the kinds it stands for", () => {
    const groups = factItems(nativeProfile.records, []).map((item) => [item.kind === "record" ? item.record.summary || item.record.value : "", item.group, item.section]);
    expect(groups).toContainEqual(["回答结构", "self", "preference"]);
    expect(groups).toContainEqual(["订单服务重构", "project", "other"]);
    expect(groups).toContainEqual(["所在科室是临床药学部。", "self", "background"]);
  });
});
