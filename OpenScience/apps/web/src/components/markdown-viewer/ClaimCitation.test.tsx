import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MarkdownViewer } from "./MarkdownViewer";
import { parseClaimMatrix } from "@/lib/claimCitations";

const report = "MIMIC-IV 为单一机构来源的公开衍生数据库 [1]<!-- claim:CLM-001 --><!-- claim:CLM-404 -->。";
const claims = parseClaimMatrix(JSON.stringify({ claims: [
  { claimId: "CLM-001", claim: "MIMIC-IV 是单一机构常规诊疗数据的公开衍生数据库。", claimType: "direct", accessLevel: "full_text",
    sourceUrl: "https://europepmc.org/articles/PMC9810617", sourceTitle: "MIMIC-IV, a freely accessible electronic health record dataset",
    identifier: "PMCID:PMC9810617", supportQuote: "In this paper we describe the public release of MIMIC-IV" },
  { claimId: "CLM-777", claim: "unsafe link", claimType: "direct", sourceUrl: "javascript:alert(1)", sourceTitle: "Bad", supportQuote: "q" },
] }));

describe("a report sentence opens what it rests on", () => {
  it("shows the claim, its verbatim quote and its source, and names a claim the matrix lacks", async () => {
    render(<MarkdownViewer variant="document" claims={claims}>{report}</MarkdownViewer>);
    // A citation that points at a claim the matrix does not hold is itself
    // something to check, so the sentence is flagged.
    const citation = screen.getByRole("button", { name: "查看这句话的依据（2 条主张，其中有未核对上的引文）" });
    await userEvent.click(citation);
    expect(await screen.findByText("MIMIC-IV 是单一机构常规诊疗数据的公开衍生数据库。")).toBeInTheDocument();
    expect(screen.getByText("“In this paper we describe the public release of MIMIC-IV”")).toBeInTheDocument();
    const source = screen.getByRole("link", { name: /MIMIC-IV, a freely accessible/ });
    expect(source).toHaveAttribute("href", "https://europepmc.org/articles/PMC9810617");
    expect(screen.getByText(/全文/)).toBeInTheDocument();
    expect(screen.getByText("证据矩阵里没有这条主张（CLM-404）。")).toBeInTheDocument();
  });

  it("marks the sentence whose quotation was not found, and says what was found for each claim", async () => {
    // The gate used to withhold the whole package over this; the reader is told
    // claim by claim instead (2026-09-17).
    const statuses = new Map([["CLM-001", "verified"], ["CLM-404", "quote_not_found"]]);
    render(<MarkdownViewer variant="document" claims={claims} claimStatuses={statuses}>{report}</MarkdownViewer>);
    const citation = screen.getByRole("button", { name: "查看这句话的依据（2 条主张，其中有未核对上的引文）" });
    expect(citation).toHaveTextContent("依据 ⚠");
    await userEvent.click(citation);
    expect(await screen.findByText("引文已在保存的原文中核对")).toBeInTheDocument();
  });

  it("a sentence whose every quotation was found is not flagged, and an unknown status is never read as verified", async () => {
    render(<MarkdownViewer variant="document" claims={claims} claimStatuses={new Map([["CLM-001", "some_future_status"]])}>{"x [1]<!-- claim:CLM-001 -->"}</MarkdownViewer>);
    const citation = screen.getByRole("button", { name: "查看这句话的依据（1 条主张）" });
    expect(citation).toHaveTextContent(/^依据$/);
    await userEvent.click(citation);
    expect(await screen.findByText("这条主张还没有被核对")).toBeInTheDocument();
    expect(screen.queryByText("引文已在保存的原文中核对")).toBeNull();
  });

  it("never links a source address that is not http(s)", async () => {
    render(<MarkdownViewer variant="document" claims={claims}>{"x [2]<!-- claim:CLM-777 -->"}</MarkdownViewer>);
    await userEvent.click(screen.getByRole("button", { name: /查看这句话的依据/ }));
    expect(await screen.findByText("Bad")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Bad/ })).toBeNull();
  });

  it("shows the claim's PICO and its certainty badge, with a quiet note when the stated level and its parts disagree", async () => {
    const appraised = parseClaimMatrix(JSON.stringify({ claims: [{
      claimId: "CLM-010", claim: "70 岁及以上成人服用阿司匹林大出血风险升高。", claimType: "direct", accessLevel: "full_text",
      sourceTitle: "ASPREE", artifactPath: ".evimed-sources/aspree/fulltext.md", supportQuote: "major hemorrhage was higher",
      pico: { population: "≥70 岁社区成人", intervention: "阿司匹林 100 mg/d", comparator: "安慰剂", outcomes: ["大出血"] },
      certainty: { start: "high", riskOfBias: -1, imprecision: -1, rationale: "见正文", label: "moderate" },
      riskOfBias: { tool: "RoB 2", domains: { D1: "low", D2: "low", D3: "low", D4: "low", D5: "low" }, overall: "low" },
    }] }));
    render(<MarkdownViewer variant="document" claims={appraised}>{"x [1]<!-- claim:CLM-010 -->"}</MarkdownViewer>);
    await userEvent.click(screen.getByRole("button", { name: /查看这句话的依据/ }));
    const list = await screen.findByLabelText("PICO");
    expect(list).toHaveTextContent("人群≥70 岁社区成人");
    expect(list).toHaveTextContent("干预阿司匹林 100 mg/d");
    expect(list).toHaveTextContent("对照安慰剂");
    expect(list).toHaveTextContent("结局大出血");
    expect(screen.getByLabelText("证据确定性：中")).toHaveTextContent("确定性 中");
    expect(screen.getByText("标注为“中”，按各分项计算为“低”")).toBeInTheDocument();
    expect(screen.getByText("偏倚风险 · RoB 2")).toBeInTheDocument();
  });

  it("a claim with no appraisal shows none of it", async () => {
    render(<MarkdownViewer variant="document" claims={claims}>{"x [1]<!-- claim:CLM-001 -->"}</MarkdownViewer>);
    await userEvent.click(screen.getByRole("button", { name: /查看这句话的依据/ }));
    expect(await screen.findByText("MIMIC-IV 是单一机构常规诊疗数据的公开衍生数据库。")).toBeInTheDocument();
    expect(screen.queryByLabelText("PICO")).toBeNull();
    expect(screen.queryByText(/确定性/)).toBeNull();
  });

  it("without a matrix the markers are removed, never printed as text", () => {
    const { container } = render(<MarkdownViewer variant="document">{report}</MarkdownViewer>);
    expect(screen.queryByRole("button", { name: /依据/ })).toBeNull();
    expect(container.textContent).toBe("MIMIC-IV 为单一机构来源的公开衍生数据库 [1]。");
    expect(container.textContent).not.toMatch(/claim:|<!--/);
  });

  it("a comment quoted as code survives", () => {
    const { container } = render(<MarkdownViewer variant="document">{"用 `<!-- claim:CLM-001 -->` 标注主张。"}</MarkdownViewer>);
    expect(container.textContent).toContain("<!-- claim:CLM-001 -->");
  });
});
