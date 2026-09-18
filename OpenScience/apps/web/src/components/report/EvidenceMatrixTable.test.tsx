import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { parseClaimMatrix } from "@/lib/claimCitations";
import { EvidenceMatrixTable } from "./EvidenceMatrixTable";

const claims = parseClaimMatrix(JSON.stringify({ claims: [
  { claimId: "CLM-001", claim: "不降低主要心血管事件。", claimType: "direct", referenceNumber: 12, sourceType: "rct", accessLevel: "full_text",
    sourceTitle: "ASPREE", identifier: "doi:10.1056/x", artifactPath: ".evimed-sources/aspree/fulltext.md", supportQuote: "did not result in a significantly lower risk" },
  { claimId: "CLM-003", claim: "三项试验综合。", claimType: "synthesized", confidence: "moderate", supportingSources: [
    { sourceType: "systematic-review", sourceTitle: "Meta", sourceUrl: "https://example.org/meta", supportQuote: "lower risk of cardiovascular events" },
    { sourceType: "rct", sourceTitle: "ARRIVE", supportQuote: "event rate was much lower than expected" },
  ] },
] }));

const verified = new Map([
  ["CLM-001", { claimId: "CLM-001", claimType: "direct", status: "verified", sources: [{ artifactPath: ".evimed-sources/aspree/fulltext.md", status: "verified" }] }],
  ["CLM-003", { claimId: "CLM-003", claimType: "synthesized", status: "source_unavailable", sources: [
    { artifactPath: null, status: "no_quote" }, { artifactPath: null, status: "source_unavailable" },
  ] }],
]);

describe("EvidenceMatrixTable", () => {
  // Appendix D §10.8: first column frozen, numbers right-aligned in tabular
  // figures, each quotation a way to where it should be.
  it("freezes the claim column, right-aligns the numbers and links each quotation", () => {
    render(<MemoryRouter><EvidenceMatrixTable claims={claims} verified={verified} runId="run_1" /></MemoryRouter>);
    const table = screen.getByRole("table", { name: "证据矩阵：2 条主张" });
    expect(table).toHaveClass("tabular-nums");
    const first = within(table).getByRole("rowheader", { name: "CLM-001" });
    expect(first).toHaveClass("sticky", "left-0");
    const number = within(table).getByText("12");
    expect(number).toHaveClass("text-right");
    expect(within(table).getByRole("link", { name: "“did not result in a significantly lower risk”" })).toHaveAttribute(
      "href", "/app/runs/run_1/files/.evimed-sources/aspree/fulltext.md?quote=did%20not%20result%20in%20a%20significantly%20lower%20risk",
    );
    // No preserved copy: the quotation opens the source itself.
    expect(within(table).getByRole("link", { name: /lower risk of cardiovascular events/ })).toHaveAttribute("href", "https://example.org/meta");
  });

  it("shows a claim's PICO and certainty in its row, the level stated and the one its parts give", () => {
    const appraised = parseClaimMatrix(JSON.stringify({ claims: [
      { claimId: "CLM-001", claim: "不降低主要心血管事件。", claimType: "direct", referenceNumber: 12, artifactPath: ".evimed-sources/aspree/fulltext.md",
        supportQuote: "did not result in a significantly lower risk",
        pico: { population: "≥70 岁社区成人", intervention: "阿司匹林", comparator: "安慰剂", outcome: "主要心血管事件" },
        certainty: { start: "high", imprecision: -1, upgrades: { largeEffect: 1 }, rationale: "见正文", label: "high" } },
    ] }));
    // The control plane stamped the source a randomized trial: the upgrade does not count.
    const checked = new Map([["CLM-001", { claimId: "CLM-001", claimType: "direct", status: "verified", sources: [
      { artifactPath: ".evimed-sources/aspree/fulltext.md", status: "verified", sourceType: "rct" },
    ] }]]);
    render(<MemoryRouter><EvidenceMatrixTable claims={appraised} verified={checked} /></MemoryRouter>);
    const row = screen.getByRole("rowheader", { name: "CLM-001" }).closest("tr")!;
    expect(within(row).getByLabelText("PICO")).toHaveTextContent("结局主要心血管事件");
    expect(within(row).getByLabelText("证据确定性：高")).toBeInTheDocument();
    expect(within(row).getByText("标注为“高”，按各分项计算为“中”")).toBeInTheDocument();
  });

  it("says what each check found, per source for a synthesized claim, with kinds of source", () => {
    render(<MemoryRouter><EvidenceMatrixTable claims={claims} verified={verified} /></MemoryRouter>);
    const row = screen.getByRole("rowheader", { name: "CLM-003" }).closest("tr")!;
    expect(within(row).getByText("⚠ 无引文")).toBeInTheDocument();
    expect(within(row).getAllByText("⚠ 原文未保存")).toHaveLength(2);
    expect(within(row).getByText("系统综述")).toBeInTheDocument();
    expect(within(row).getByText("把握度中")).toBeInTheDocument();
    expect(within(screen.getByRole("rowheader", { name: "CLM-001" }).closest("tr")!).getByText("✓ 已核对")).toBeInTheDocument();
  });
});
