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
    const citation = screen.getByRole("button", { name: "查看这句话的依据（2 条主张）" });
    await userEvent.click(citation);
    expect(await screen.findByText("MIMIC-IV 是单一机构常规诊疗数据的公开衍生数据库。")).toBeInTheDocument();
    expect(screen.getByText("“In this paper we describe the public release of MIMIC-IV”")).toBeInTheDocument();
    const source = screen.getByRole("link", { name: /MIMIC-IV, a freely accessible/ });
    expect(source).toHaveAttribute("href", "https://europepmc.org/articles/PMC9810617");
    expect(screen.getByText(/全文/)).toBeInTheDocument();
    expect(screen.getByText("证据矩阵里没有这条主张（CLM-404）。")).toBeInTheDocument();
  });

  it("never links a source address that is not http(s)", async () => {
    render(<MarkdownViewer variant="document" claims={claims}>{"x [2]<!-- claim:CLM-777 -->"}</MarkdownViewer>);
    await userEvent.click(screen.getByRole("button", { name: /查看这句话的依据/ }));
    expect(await screen.findByText("Bad")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Bad/ })).toBeNull();
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
