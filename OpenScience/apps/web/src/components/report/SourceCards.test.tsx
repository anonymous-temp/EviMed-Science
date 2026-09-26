import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { parseClaimMatrix, type ClaimVerification } from "@/lib/claimCitations";
import type { VerifiedClaim } from "@/components/markdown-viewer/ClaimCitation";
import { SourceCardList, sourceCardEntries, sourceCompositionOf } from "./SourceCards";

// One matrix with a source of each kind the composition line names, one of
// them retracted and one whose quotation was not found in its preserved copy.
const claims = parseClaimMatrix(JSON.stringify({ claims: [
  { claimId: "CLM-001", claim: "指南推荐二甲双胍为首选。", claimType: "direct", sourceTitle: "中国 2 型糖尿病防治指南（2020 年版）",
    identifier: "CN-GL-2020", sourceType: "guideline", artifactPath: ".evimed-sources/gl/page.txt", supportQuote: "二甲双胍是首选用药。" },
  { claimId: "CLM-002", claim: "全因死亡下降 36%。", claimType: "direct", sourceTitle: "UKPDS 34", identifier: "PMID 9742977",
    sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/9742977/", sourceType: "rct", artifactPath: ".evimed-sources/ukpds/page.txt",
    supportQuote: "36% for all-cause mortality" },
  { claimId: "CLM-003", claim: "汇总结果不一致。", claimType: "direct", sourceTitle: "Metformin and CVD: a meta-analysis",
    identifier: "10.1000/meta", sourceType: "meta-analysis", artifactPath: ".evimed-sources/meta/page.txt", supportQuote: "no significant effect" },
  // The same work again, under the same identifier: one card, two claims.
  { claimId: "CLM-004", claim: "同一试验的次要结局。", claimType: "direct", sourceTitle: "UKPDS 34", identifier: "PMID 9742977",
    sourceType: "rct", supportQuote: "39% for myocardial infarction" },
] }));

const verification: ClaimVerification = {
  claims: [
    { claimId: "CLM-001", claimType: "direct", status: "verified", sources: [{ artifactPath: ".evimed-sources/gl/page.txt", status: "verified", sourceType: "guideline" }] },
    { claimId: "CLM-002", claimType: "direct", status: "quote_not_found", sources: [{ artifactPath: ".evimed-sources/ukpds/page.txt", status: "quote_not_found", sourceType: "rct" }] },
    { claimId: "CLM-003", claimType: "direct", status: "verified", sources: [{ artifactPath: ".evimed-sources/meta/page.txt", status: "verified", sourceType: "meta-analysis",
      doi: "10.1000/meta", updates: [{ kind: "retraction", noticeDoi: "10.1000/notice", date: "2024-03-01", source: "retraction-watch" }] }] },
    { claimId: "CLM-004", claimType: "direct", status: "verified", sources: [{ artifactPath: null, status: "no_quote" }] },
  ],
  counts: { verified: 3, quote_not_found: 1 },
};

const verified = new Map<string, VerifiedClaim>(verification.claims.map((claim) => [claim.claimId, claim]));

function renderList() {
  return render(
    <MemoryRouter>
      <SourceCardList claims={claims} verified={verified} runId="run_1" />
    </MemoryRouter>,
  );
}

describe("the sources a report stands on, as cards", () => {
  it("counts what the composition line claims, over the cards below it", () => {
    renderList();
    const section = screen.getByRole("region", { name: /来源/ });
    expect(within(section).getByRole("heading", { name: "来源 3" })).toBeInTheDocument();
    expect(within(section).getByText("指南 1 · Meta 分析 1 · RCT 1")).toBeInTheDocument();
    // The line is counted from the cards, not restated from the payload.
    const entries = sourceCardEntries(claims.values(), verified);
    expect(entries).toHaveLength(3);
    expect(sourceCompositionOf(entries).reduce((sum, entry) => sum + entry.count, 0)).toBe(entries.length);
    expect(section.querySelectorAll("[data-source-index]")).toHaveLength(3);
    // One work cited twice is one card.
    expect(entries.find((entry) => entry.title === "UKPDS 34")?.claims).toBe(2);
  });

  it("wears the study-type badge in the palette's own colour, and says nothing for a kind the table cannot tell", () => {
    renderList();
    const rct = screen.getByText("RCT");
    expect(rct).toHaveAttribute("data-study-type", "rct");
    expect(rct.getAttribute("style")).toContain("var(--study-rct-fg)");
    expect(screen.getByText("指南")).toHaveAttribute("data-study-type", "guideline");
    // `other` is the table saying it cannot tell; it draws no badge.
    const unknown = parseClaimMatrix(JSON.stringify({ claims: [{ claimId: "CLM-009", claim: "x", claimType: "direct", sourceTitle: "A blog post", identifier: "x-1" }] }));
    render(<MemoryRouter><SourceCardList claims={unknown} /></MemoryRouter>);
    expect(screen.queryByText("其他")).toBeNull();
  });

  it("shows the quotation with its verification mark, and the identifier with a way to copy it", () => {
    renderList();
    // Two sources checked out; each carries its own mark.
    expect(screen.getAllByLabelText("引文已核对")).toHaveLength(2);
    expect(screen.getAllByLabelText("引文已核对")[0]).toHaveTextContent("✓");
    expect(screen.getByLabelText("引文未在原文中找到")).toHaveTextContent("⚠");
    // The quotation is the thing a reader compares against the sentence, so
    // it is marked, not merely quoted.
    const quote = screen.getByText("“36% for all-cause mortality”");
    expect(quote.tagName).toBe("MARK");
    expect(screen.getByRole("button", { name: "复制 PMID 9742977" })).toBeInTheDocument();
    // A preserved source opens at the quotation.
    expect(screen.getAllByRole("link", { name: /定位原文/ }).length).toBeGreaterThan(0);
  });

  it("puts a retracted work's notice in a strip of its own", () => {
    renderList();
    const card = screen.getByText("Metformin and CVD: a meta-analysis").closest("[data-source-index]")!;
    const notice = within(card as HTMLElement).getByRole("link", { name: /已撤稿/ });
    expect(notice).toHaveAttribute("href", "https://doi.org/10.1000/notice");
    expect(notice).toHaveTextContent("已撤稿 · 2024-03-01");
    // The check answered with the work's DOI, so the card can offer it.
    expect(within(card as HTMLElement).getByRole("button", { name: /复制/ })).toHaveTextContent("10.1000/meta");
  });

  it("draws nothing at all when the claims name no source", () => {
    const none = parseClaimMatrix(JSON.stringify({ claims: [{ claimId: "CLM-010", claim: "x", claimType: "derived", method: "m" }] }));
    const { container } = render(<MemoryRouter><SourceCardList claims={none} /></MemoryRouter>);
    expect(container).toBeEmptyDOMElement();
  });
});
