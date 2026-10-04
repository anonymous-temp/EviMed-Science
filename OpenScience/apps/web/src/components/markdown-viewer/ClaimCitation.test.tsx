import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { claimVerification } from "@evimed/domain/clinical-evidence";
import { MemoryRouter } from "react-router";
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
    const citation = screen.getByRole("button", { name: "查看这句话的依据（2 条结论，其中有未核对上的引文）" });
    await userEvent.click(citation);
    expect(await screen.findByText("MIMIC-IV 是单一机构常规诊疗数据的公开衍生数据库。")).toBeInTheDocument();
    expect(screen.getByText("“In this paper we describe the public release of MIMIC-IV”")).toBeInTheDocument();
    const source = screen.getByRole("link", { name: /MIMIC-IV, a freely accessible/ });
    expect(source).toHaveAttribute("href", "https://europepmc.org/articles/PMC9810617");
    // The checker's bookkeeping — access level, source kind, claim id — stays off the popover.
    expect(screen.queryByText(/全文|直接证据|把握度/)).toBeNull();
    expect(screen.getByText("证据矩阵里没有这条结论（CLM-404）。")).toBeInTheDocument();
  });

  it("marks the sentence whose quotation was not found, and says what was found for each claim", async () => {
    // The gate used to withhold the whole package over this; the reader is told
    // claim by claim instead (2026-09-17).
    const statuses = new Map([["CLM-001", "verified"], ["CLM-404", "quote_not_found"]]);
    render(<MarkdownViewer variant="document" claims={claims} claimStatuses={statuses}>{report}</MarkdownViewer>);
    const citation = screen.getByRole("button", { name: "查看这句话的依据（2 条结论，其中有未核对上的引文）" });
    expect(citation).toHaveTextContent("依据 ⚠");
    await userEvent.click(citation);
    expect(await screen.findByLabelText("引文已在保存的原文中核对")).toHaveTextContent("✓");
  });

  it("a sentence whose every quotation was found is not flagged, and an unknown status is never read as verified", async () => {
    render(<MarkdownViewer variant="document" claims={claims} claimStatuses={new Map([["CLM-001", "some_future_status"]])}>{"x [1]<!-- claim:CLM-001 -->"}</MarkdownViewer>);
    const citation = screen.getByRole("button", { name: "查看这句话的依据（1 条结论）" });
    expect(citation).toHaveTextContent(/^依据$/);
    await userEvent.click(citation);
    expect(await screen.findByText("MIMIC-IV 是单一机构常规诊疗数据的公开衍生数据库。")).toBeInTheDocument();
    expect(screen.queryByLabelText("引文已在保存的原文中核对")).toBeNull();
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

  it("shows where the quotation sits in its source, the page as unknown where only the table is, and the place as unknown where it is", async () => {
    const located = new Map([["CLM-001", { claimId: "CLM-001", claimType: "direct", status: "verified", sources: [{ artifactPath: null, status: "verified", location: {
      status: "located", table: { id: "tbl-1", index: 1, label: "Table 2" }, row: 3, cell: { row: 3, column: 2, header: "Placebo (n=120)" }, page: { status: "unknown", reason: "no_page_markers" },
    } }] }]]);
    const { unmount } = render(<MarkdownViewer variant="document" claims={claims} reading={{ verified: located }}>{"x [1]<!-- claim:CLM-001 -->"}</MarkdownViewer>);
    await userEvent.click(screen.getByRole("button", { name: /查看这句话的依据/ }));
    expect(await screen.findByText("位置：Table 2 第 3 行第 2 列 · 页码未知")).toBeInTheDocument();
    unmount();
    const unknown = new Map([["CLM-001", { claimId: "CLM-001", claimType: "direct", status: "verified", sources: [{ artifactPath: null, status: "verified", location: {
      status: "unknown", page: { status: "unknown", reason: "no_page_markers" }, reason: "not_in_a_table" } }] }]]);
    render(<MarkdownViewer variant="document" claims={claims} reading={{ verified: unknown }}>{"x [1]<!-- claim:CLM-001 -->"}</MarkdownViewer>);
    await userEvent.click(screen.getByRole("button", { name: /查看这句话的依据/ }));
    expect(await screen.findByText("位置：位置未知")).toBeInTheDocument();
  });

  it("a verification that carries no location shows no location line", async () => {
    const old = new Map([["CLM-001", { claimId: "CLM-001", claimType: "direct", status: "verified", sources: [{ artifactPath: null, status: "verified" }] }]]);
    render(<MarkdownViewer variant="document" claims={claims} reading={{ verified: old }}>{"x [1]<!-- claim:CLM-001 -->"}</MarkdownViewer>);
    await userEvent.click(screen.getByRole("button", { name: /查看这句话的依据/ }));
    expect(await screen.findByText("MIMIC-IV 是单一机构常规诊疗数据的公开衍生数据库。")).toBeInTheDocument();
    expect(document.querySelector("[data-source-location]")).toBeNull();
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

  it.each([
    "./.evimed-sources/a/fulltext.md",
    ".evimed-sources/a/../a/fulltext.md",
    ".evimed-sources/../../outside.md",
  ])("shows an unsafe explicit quotation at %s with a warning and no file link", async (artifactPath) => {
    const matrix = { claims: [{
      claimId: "CLM-053", claim: "Two reviews describe the evidence.", claimType: "synthesized",
      artifactPath, sourceTitle: "Top-level review", sourceUrl: "https://www.nice.org.uk/guidance/ng136", supportQuote: "The search ended in June 2019.",
      supportingSources: [
        { artifactPath: ".evimed-sources/a/fulltext.md", sourceTitle: "Earlier review", supportQuote: "The search ended in December 2014." },
        { artifactPath: ".evimed-sources/b/fulltext.md", sourceTitle: "Later review", supportQuote: "Randomized studies were included." },
      ],
    }] };
    const verification = claimVerification({ matrix, sourceArtifacts: {
      ".evimed-sources/a/fulltext.md": "The search ended in December 2014.",
      ".evimed-sources/b/fulltext.md": "Randomized studies were included.",
    } });
    render(<MemoryRouter><MarkdownViewer variant="document" claims={parseClaimMatrix(JSON.stringify(matrix))}
      reading={{ runId: "run_1", verified: new Map(verification.claims.map((claim) => [claim.claimId, claim])) }}>
      {"Two reviews [1]<!-- claim:CLM-053 -->."}
    </MarkdownViewer></MemoryRouter>);
    const citation = screen.getByRole("button", { name: /查看这句话的依据/ });
    expect(citation).toHaveTextContent("依据 ⚠");
    await userEvent.click(citation);
    const top = (await screen.findByText("“The search ended in June 2019.”")).closest("[data-quote-index]") as HTMLElement;
    expect(top).toHaveAttribute("data-quote-index", "2");
    expect(within(top).getByLabelText("这条结论没有给出可核对的引文")).toHaveTextContent("⚠");
    expect(within(top).getByRole("link", { name: "Top-level review" })).toHaveAttribute("href", matrix.claims[0].sourceUrl);
    expect(within(top).queryByRole("link", { name: "定位原文" })).toBeNull();
    expect(screen.getAllByRole("link", { name: "定位原文" })).toHaveLength(2);
    expect(screen.getByText(/^⚠ 第 3 段引文缺少/)).toBeInTheDocument();
    expect(screen.getAllByLabelText("引文已在保存的原文中核对")).toHaveLength(2);
  });
});
