import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EvidenceCardHeader, evidenceCurrencyLabel, evidenceNatureLabel, evidenceVerificationTally } from "./EvidenceCardHeader";
import { card } from "./__fixtures__/evidenceCards";

describe("the top of a card", () => {
  // The day is written the way the rest of the app writes one (「10月4日」 this year), so the clock is fixed.
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-10T08:00:00Z")); });
  afterEach(() => vi.useRealTimers());
  it("is one line — who made it, the day it was updated, and ✓ n/m — and says nothing else of the card (R19: it was four labels)", () => {
    render(<EvidenceCardHeader evidence={card} updatedAt="2026-10-04T12:00:00Z" />);
    const header = screen.getByTestId("evidence-card-header");
    expect(header).toHaveClass("flex-wrap");
    expect(header.children).toHaveLength(3);
    expect(header).toHaveTextContent("李研究更新于 10月4日✓1/2");
    // 性质 and a current 时效 are rows of the fold under the answer, not tags here.
    expect(header).not.toHaveTextContent(/性质|时效|出品方|无利益关系|引文已核对/);
    expect(header.querySelector("[data-tag]")).toBeNull();
  });
  it("says a producer's interest in the products the card concerns, in words, on the line", () => {
    render(<EvidenceCardHeader evidence={{ ...card, originality: "original_research", primary: true, producer: { kind: "enterprise", name: "某药企", relation: "own_product", products: ["药 A"] } }} />);
    expect(screen.getByTestId("evidence-card-header")).toHaveTextContent("某药企 · 涉及出品方自己的产品");
  });
  it("shows a 时效 that is not current, in warning colour, and never a current one nor a guessed one", () => {
    const { rerender } = render(<EvidenceCardHeader evidence={{ ...card, currency: "source_changed" }} />);
    expect(screen.getByText("来源已撤稿或更正")).toBeInTheDocument();
    rerender(<EvidenceCardHeader evidence={{ ...card, currency: "current" }} />);
    expect(screen.queryByText(/现行|时效/)).not.toBeInTheDocument();
    rerender(<EvidenceCardHeader evidence={{ ...card, currency: "no-such-label" }} />);
    expect(screen.queryByText(/时效/)).not.toBeInTheDocument();
    expect(evidenceCurrencyLabel({ currency: "source_changed" })).toBe("来源已撤稿或更正");
    expect(evidenceCurrencyLabel({ currency: "no-such-label" })).toBeNull();
    expect(evidenceCurrencyLabel({})).toBeNull();
  });
  it("makes ✓ n/m a button that goes to the conclusions it counts, and a plain number where nothing can be gone to", async () => {
    const open = vi.fn();
    const { rerender } = render(<EvidenceCardHeader evidence={card} onOpenClaims={open} />);
    const button = screen.getByRole("button", { name: "引文已核对 1/2，查看证据要点" });
    expect(button).toHaveTextContent("✓1/2");
    await userEvent.click(button);
    expect(open).toHaveBeenCalledTimes(1);
    rerender(<EvidenceCardHeader evidence={card} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByLabelText("引文已核对 1/2")).toHaveTextContent("✓1/2");
  });
  it("counts the claims that carry a quotation: an estimate is not one, and no claims is no number", () => {
    expect(evidenceVerificationTally({ claimVerification: { total: 5, verified: 3, quote_not_found: 1, source_unavailable: 0, no_quote: 0, derived: 2 } })).toEqual({ verified: 3, checkable: 3 });
    expect(evidenceVerificationTally({ claimVerification: { total: 1, verified: 0, quote_not_found: 0, source_unavailable: 0, no_quote: 0, derived: 1 } })).toBeNull();
    expect(evidenceVerificationTally({ claimVerification: null })).toBeNull();
    const { container } = render(<EvidenceCardHeader evidence={{ ...card, producer: null, originality: null, claimVerification: null }} />);
    expect(container).toBeEmptyDOMElement();
  });
  it("marks a draft, and draws a line for a card that has only that or only a day", () => {
    const bare = { ...card, producer: null, originality: null, claimVerification: null, currency: undefined };
    const { container, rerender } = render(<EvidenceCardHeader evidence={bare} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<EvidenceCardHeader evidence={{ ...bare, state: "draft" }} />);
    expect(screen.getByText("草稿")).toBeInTheDocument();
    rerender(<EvidenceCardHeader evidence={bare} updatedAt="2026-10-04T12:00:00Z" />);
    expect(screen.getByText("更新于 10月4日")).toBeInTheDocument();
  });
  it("tells the 性质 of a card in one phrase, for the fold's row and a list's line alike", () => {
    expect(evidenceNatureLabel({ originality: "synthesis", primary: false })).toBe("解读 · 综合");
    expect(evidenceNatureLabel({ originality: "original_research", primary: true })).toBe("一手 · 原创研究");
    expect(evidenceNatureLabel({ originality: null, primary: false })).toBeNull();
    expect(evidenceNatureLabel({ originality: "no-such-kind" as never, primary: false })).toBeNull();
  });
});
