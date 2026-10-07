import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EvidenceDiscussionList, EvidenceReviews, EvidenceRevisions, evidenceDiscussionCount } from "./EvidenceDiscussion";
import { card } from "./__fixtures__/evidenceCards";

describe("what readers made of a card", () => {
  it("counts the written reviews and the comments, and nothing else, for the fold's name", () => {
    expect(evidenceDiscussionCount({ reviews: undefined, discussion: [] })).toBe(0);
    expect(evidenceDiscussionCount({
      reviews: [{ author: "甲", score: 4, text: "好", createdAt: "2026-10-04T12:00:00Z", revision: 2, current: true }],
      discussion: [{ author: "乙", text: "问题", createdAt: null }, { author: "丙", text: "回答", createdAt: null }],
    })).toBe(3);
  });

  it("offers deletion only for the reader-owned discussion", async () => {
    const remove = vi.fn();
    render(<EvidenceDiscussionList evidence={{ ...card, discussion: [{ id: "mine", canDelete: true, author: "Me", text: "My discussion", createdAt: null }, { id: "other", canDelete: false, author: "Other", text: "Other discussion", createdAt: null }] }} onDeleteComment={remove} />);
    expect(screen.getAllByRole("button", { name: "删除我的讨论" })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "删除我的讨论" }));
    expect(remove).toHaveBeenCalledWith("mine");
  });

  it("says plainly that there is no discussion yet", () => {
    render(<EvidenceDiscussionList evidence={card} />);
    expect(screen.getByText("暂无讨论")).toBeInTheDocument();
  });

  it("states the AI review, its findings and whether a reader has reviewed the current content, without naming a model", () => {
    render(<EvidenceReviews evidence={{
      ...card,
      editorial: { author: { kind: "ai", name: "写作 AI", model: "synthetic-writer" }, reviewer: { kind: "ai", name: "核对 AI", model: "synthetic-reviewer" }, status: "ai-reviewed", reviewRevision: card.revision, reviewedAt: "2026-10-04T12:00:00Z", findings: [{ kind: "coverage", text: "结论 2 的引文没有找到" }] },
      review: { score: 4, label: "良好" },
      reviews: [{ author: "王医生", score: 5, text: "引文都对", createdAt: "2026-10-04T12:00:00Z", revision: 2, current: true }, { author: "李药师", score: 2, text: "旧版有问题", createdAt: "2026-10-02T12:00:00Z", revision: 1, current: false }],
    }} />);
    expect(screen.getByText("AI 证据评议")).toBeInTheDocument();
    expect(screen.getByText("当前内容已完成 AI 评议")).toBeInTheDocument();
    expect(screen.getByText("结论 2 的引文没有找到")).toBeInTheDocument();
    expect(screen.getByText("学术评议")).toBeInTheDocument();
    expect(screen.getByText(/王医生 · 5 \/ 5/)).toBeInTheDocument();
    expect(screen.getByText(/李药师 · 2 \/ 5 · 历史版本/)).toBeInTheDocument();
    expect(screen.queryByText("尚无当前内容的用户评议")).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/synthetic-|模型/);
  });

  it("says a review is pending, and nothing is drawn for a card with no review at all", () => {
    const { container, rerender } = render(<EvidenceReviews evidence={{ ...card, editorial: { author: { kind: "ai", name: "写作 AI" }, reviewer: null, status: "review-pending", reviewRevision: null } }} />);
    expect(screen.getByText("待评议")).toBeInTheDocument();
    expect(screen.getByText("当前内容待重新评议")).toBeInTheDocument();
    expect(screen.getByText("尚无当前内容的用户评议")).toBeInTheDocument();
    rerender(<EvidenceReviews evidence={{ ...card, editorial: null, review: null, reviews: [] }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists the revisions newest first and flags the one whose sources changed, and has nothing to say about a single revision", () => {
    const revision = (n: number, fingerprint: string) => ({ revision: n, recordedAt: `2026-10-0${n}T12:00:00Z`, title: `第 ${n} 版`, sourceFingerprint: fingerprint, reviewStatus: null });
    const { container, rerender } = render(<EvidenceRevisions evidence={{ ...card, revisions: [revision(2, "b"), revision(1, "a")] }} />);
    expect(screen.getAllByRole("listitem").map((row) => row.textContent)).toEqual([expect.stringContaining("第 2 版"), expect.stringContaining("第 1 版")]);
    expect(screen.getByText("依据来源有更新")).toBeInTheDocument();
    expect(screen.getByText(/当前内容/)).toBeInTheDocument();
    rerender(<EvidenceRevisions evidence={{ ...card, revisions: [revision(1, "a")] }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
