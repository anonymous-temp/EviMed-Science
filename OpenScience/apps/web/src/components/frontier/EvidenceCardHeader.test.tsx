import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EvidenceCardHeader, evidenceNatureLabel, evidenceVerificationTally } from "./EvidenceCardHeader";
import { card } from "./__fixtures__/evidenceCards";

describe("the top of a card", () => {
  it("names the producer and how they relate to the products, then the labels as small plain tags", () => {
    render(<EvidenceCardHeader evidence={card} />);
    const header = screen.getByTestId("evidence-card-header");
    expect(header).toHaveTextContent("出品方 李研究 · 用户 · 与所涉产品无利益关系");
    expect(screen.getByText("性质 解读 · 综合")).toBeInTheDocument();
    expect(screen.getByText("核验 1/2")).toBeInTheDocument();
    expect(screen.queryByText(/时效/)).not.toBeInTheDocument();
  });
  it("calls first-hand work first-hand, and a company's card as the company's own", () => {
    render(<EvidenceCardHeader evidence={{ ...card, originality: "original_research", primary: true, producer: { kind: "enterprise", name: "某药企", relation: "own_product", products: ["药 A"] } }} />);
    expect(screen.getByText("性质 一手 · 原创研究")).toBeInTheDocument();
    expect(screen.getByTestId("evidence-card-header")).toHaveTextContent("某药企 · 企业 · 涉及出品方自己的产品");
  });
  it("shows the 时效 label when the server sends one, and never guesses one", () => {
    const { rerender } = render(<EvidenceCardHeader evidence={{ ...card, currency: "source_changed" }} />);
    expect(screen.getByText("时效 来源已撤稿或更正")).toBeInTheDocument();
    rerender(<EvidenceCardHeader evidence={{ ...card, currency: "no-such-label" }} />);
    expect(screen.queryByText(/时效/)).not.toBeInTheDocument();
  });
  it("counts the claims that carry a quotation: an estimate is not one, and no claims is no tag", () => {
    expect(evidenceVerificationTally({ claimVerification: { total: 5, verified: 3, quote_not_found: 1, source_unavailable: 0, no_quote: 0, derived: 2 } })).toEqual({ verified: 3, checkable: 3 });
    expect(evidenceVerificationTally({ claimVerification: { total: 1, verified: 0, quote_not_found: 0, source_unavailable: 0, no_quote: 0, derived: 1 } })).toBeNull();
    expect(evidenceVerificationTally({ claimVerification: null })).toBeNull();
    const { container } = render(<EvidenceCardHeader evidence={{ ...card, producer: null, originality: null, claimVerification: null }} />);
    expect(container).toBeEmptyDOMElement();
  });
  it("is one wrapping row — the producer, the tags and the day of the last update — not a stack of lines", () => {
    render(<EvidenceCardHeader evidence={card} updatedAt="2026-10-04T12:00:00Z" />);
    const header = screen.getByTestId("evidence-card-header");
    expect(header).toHaveClass("flex-wrap");
    expect(header.children).toHaveLength(4);
    expect(screen.getByText("更新于 2026/10/4")).toBeInTheDocument();
    expect(header.lastElementChild).toHaveTextContent("更新于 2026/10/4");
  });
  it("marks a draft, and draws a row for a card that has only that or only a day", () => {
    const bare = { ...card, producer: null, originality: null, claimVerification: null, currency: undefined };
    const { container, rerender } = render(<EvidenceCardHeader evidence={bare} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<EvidenceCardHeader evidence={{ ...bare, state: "draft" }} />);
    expect(screen.getByText("草稿")).toBeInTheDocument();
    rerender(<EvidenceCardHeader evidence={bare} updatedAt="2026-10-04T12:00:00Z" />);
    expect(screen.getByText("更新于 2026/10/4")).toBeInTheDocument();
  });
  it("tells the 性质 of a card in one phrase, for the header's tag and a list's line alike", () => {
    expect(evidenceNatureLabel({ originality: "synthesis", primary: false })).toBe("解读 · 综合");
    expect(evidenceNatureLabel({ originality: "original_research", primary: true })).toBe("一手 · 原创研究");
    expect(evidenceNatureLabel({ originality: null, primary: false })).toBeNull();
    expect(evidenceNatureLabel({ originality: "no-such-kind" as never, primary: false })).toBeNull();
  });
});
