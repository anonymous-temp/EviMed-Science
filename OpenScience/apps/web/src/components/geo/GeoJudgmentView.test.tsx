import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { OriginalJudgment, genericMentionsText, judgmentRows } from "./GeoJudgmentView";

const judgment = {
  judgedAt: "2026-10-02 10:00", questionVersion: 4, parserVersion: "parser-9.9", registryKey: "registry_internal_1",
  brands: [{ name: "Alpha", ours: true, competitor: false, count: 2, position: 1, inRecommendation: true }, { name: "Beta", ours: false, competitor: true, count: 1, position: 2, inRecommendation: false }],
  checks: { judgementCoverage: { status: "partial", reasons: ["answer_cut"], answerChars: 900, assessedChars: 500 } },
  retrievalTriggered: true, redFlagExpected: ["F1", "F2"], redFlagHits: ["F1"],
  statements: [{ text: "Alpha is for adults", verdict: "wrong", claimId: "claim_internal_8", claimVersion: 3, applicability: { population: "Adults" }, evidence: "Label says adults only" }],
};

it("words a stored judgment: verdicts, statements, brands with counts, and none of its ids or versions", () => {
  const { container } = render(<OriginalJudgment judgment={judgment} />);
  expect(screen.getByText("Alpha（本品） 2 次；Beta（竞品） 1 次")).toBeVisible();
  expect(screen.getByText("只判定了部分回答")).toBeVisible();
  expect(screen.getByText("错误")).toBeVisible();
  expect(screen.getByText("Alpha is for adults")).toBeVisible();
  expect(screen.getByText("适用人群：Adults")).toBeVisible();
  expect(screen.getByText("Label says adults only")).toBeVisible();
  expect(screen.getByText("应提到 2 项，回答提到 1 项")).toBeVisible();
  for (const leak of ["claim_internal_8", "parser-9.9", "registry_internal_1", "answer_cut", "{", "[{", "wrong", "true"]) expect(container.textContent).not.toContain(leak);
});

it("says so, in a sentence, when the judgment holds nothing a reader can use", () => {
  render(<OriginalJudgment judgment={{ parserVersion: "x" }} />);
  expect(screen.getByText("没有保留可读的判定内容。")).toBeVisible();
  expect(judgmentRows("not a record")).toEqual([]);
});

it("says what the generic names were, that there were none, or that the extraction was never kept", () => {
  expect(genericMentionsText([{ name: "semaglutide", ours: true, competitor: false, count: 3, matchedNames: ["司美格鲁肽"] }, { name: "tirzepatide", ours: false, competitor: true, count: 1 }, { name: "other", count: 1 }]))
    .toBe("semaglutide（本品） 3 次；tirzepatide（竞品） 1 次；other（其他） 1 次");
  expect(genericMentionsText([])).toBe("回答中没有提到");
  expect(genericMentionsText(null)).toBe("未保留");
});
