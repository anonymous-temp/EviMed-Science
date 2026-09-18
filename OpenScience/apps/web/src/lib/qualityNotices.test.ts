import { describe, expect, it } from "vitest";
import type { WebQualityNotice } from "@/lib/apiClient";
import { noticeCountsLine, splitNoticeBody, summarizeQualityNotices } from "./qualityNotices";

const notice = (overrides: Partial<WebQualityNotice>): WebQualityNotice => ({
  code: "claim_numeric_fact_missing",
  severity: "advice",
  title: "数字未在所引原文中出现",
  text: "claims[52].claim numeric fact 6 is not present in its direct support.",
  ...overrides,
});

describe("structured gate findings", () => {
  it("groups by the gate's own check and splits them three ways by severity", () => {
    const summary = summarizeQualityNotices([
      notice({ severity: "safety", code: "safety_rule", check: "clinical-safety", title: "急救指征写错", detail: "临床实践要点第 12 行把呼叫急救的条件写成了服药后是否缓解。" }),
      notice({ severity: "must-fix", code: "quote_not_found", check: "quote-bond", title: "引文不在所引来源中", detail: "第 3 条结论的引文未在保存的原文中找到。", claimId: "CLM-003" }),
      notice({ severity: "must-fix", code: "quote_not_found", check: "quote-bond", title: "引文不在所引来源中", detail: "第 9 条结论的引文未在保存的原文中找到。", claimId: "CLM-009" }),
      notice({ detail: "报告第 40 行的数字 6 未在所引原文中出现。" }),
    ]);
    expect(summary.counts).toEqual({ safety: 1, mustFix: 2, advice: 1, total: 4 });
    expect(summary.safety[0]).toMatchObject({ label: "急救指征写错", count: 1 });
    expect(summary.mustFix).toHaveLength(1);
    expect(summary.mustFix[0]).toMatchObject({ label: "引文不在所引来源中", count: 2 });
    expect(summary.mustFix[0].lines.map((line) => line.claimId)).toEqual(["CLM-003", "CLM-009"]);
    expect(noticeCountsLine(summary)).toBe("临床安全 1 项 · 必须修改 2 项 · 提示 1 项");
  });

  // `text` is the old sentence, kept for old readers; it is never the line.
  it("never makes the legacy English sentence a line", () => {
    const summary = summarizeQualityNotices([notice({ detail: undefined })]);
    const lines = summary.advice.flatMap((group) => group.lines.map((line) => line.text));
    expect(lines.join("")).not.toMatch(/claims\[|numeric fact/);
    expect(summary.advice[0].label).toBe("数字未在所引原文中出现");
  });

  it("drops what is not a finding instead of printing it", () => {
    const summary = summarizeQualityNotices([{ nonsense: true }, 42, null, "", notice({ severity: "bogus" as never })]);
    expect(summary.counts.total).toBe(0);
  });
});

describe("findings on records written before the gate emitted codes", () => {
  it("reads the severity off the gate's prefix and never prints an English sentence", () => {
    const summary = summarizeQualityNotices([
      "claims[0].claim numeric fact 10 is not present in its direct support.",
      "MUST FIX — Reading retrieved evidence was delegated to a child that restated it.",
      "citation-ledger.csv row 3 has no DOI.",
      "Something the table does not know about.",
    ]);
    expect(summary.counts).toEqual({ safety: 0, mustFix: 1, advice: 3, total: 4 });
    expect(summary.mustFix[0]).toMatchObject({ label: "检索到的原文由子任务转述", lines: [] });
    expect(summary.mustFix[0].technical[0]).toMatch(/^MUST FIX/);
    expect(summary.advice.map((group) => group.label)).toEqual(expect.arrayContaining(["证据矩阵主张", "引文台账与参考文献"]));
    // The one the frozen table does not know is not given an invented heading.
    expect(summary.technicalCount).toBe(1);
    expect(summary.advice.find((group) => group.unlabelled)?.technical).toEqual(["Something the table does not know about."]);
    const printed = [...summary.mustFix, ...summary.advice].flatMap((group) => group.lines);
    expect(printed).toEqual([]);
  });

  it("shows an old safety finding, which was always written in Chinese, as it is", () => {
    const summary = summarizeQualityNotices([
      "SAFETY — 临床实践要点第 12 行把呼叫急救的条件写成了服药后是否缓解。",
      "MUST FIX — claims[2].supportQuote was not found in its preserved source artifact.",
    ]);
    expect(summary.safety[0].lines[0].text).toBe("临床实践要点第 12 行把呼叫急救的条件写成了服药后是否缓解。");
    expect(summary.mustFix[0]).toMatchObject({ label: "证据矩阵主张", count: 1, lines: [] });
  });
});

describe("an inbox body", () => {
  it("keeps the Chinese lines and holds back the sentences written for the run", () => {
    const body = [
      "结果已交付，但有质量检查没有通过，需要你自己复核后再使用。",
      "本次运行产出 4 个文件，仍在工作区里，可以直接打开。",
      "MUST FIX — claims[52].claim numeric fact 6 is not present in its direct support.",
      "Report line 9 numeric facts 12 have no evidence-matrix claim reference.",
    ].join("\n");
    const split = splitNoticeBody(body);
    expect(split.lines).toHaveLength(2);
    expect(split.technical).toHaveLength(2);
    expect(split.lines.join("")).not.toMatch(/[A-Za-z]{6,}/);
  });
});
