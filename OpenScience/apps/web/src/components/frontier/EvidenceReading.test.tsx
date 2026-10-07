import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EvidenceReading, evidenceUpdatedAt } from "./EvidenceReading";
import type { EvidenceCard } from "@/lib/evidenceZoneClient";
import { card as richCard } from "./__fixtures__/evidenceCards";

const card: EvidenceCard = { id: "one", revision: 1, state: "published", canEdit: false, zoneId: "zone", body: "<script>untrusted</script>", title: "急诊证据", subtype: "academic", summary: "结论", creator: null, reviewer: null, reviewedAt: null, claims: [{ text: "证据结论 [1]" }], sources: [{ title: "不安全链接", url: "javascript:alert(1)", excerpt: "原文引句" }, { title: "论文", url: "https://example.org/paper", excerpt: null }], limitations: "样本较少", discussion: [], review: null, canResearch: true };

/** The one closed fold under the answer. */
const fold = (container: HTMLElement) => container.querySelector("details") as HTMLDetailsElement;

describe("evidence reading", () => {
  it("preserves evidence/source/limitations without inventing author or grade", () => {
    const { container } = render(<EvidenceReading evidence={card} />);
    expect(screen.getByText("样本较少")).toBeInTheDocument();
    expect(screen.getByText("原文引句")).toBeInTheDocument();
    expect(screen.queryByText(/创作者|审核者|学术评议/)).not.toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByRole("link", { name: "论文" })).toHaveAttribute("href", "https://example.org/paper");
    expect(screen.queryByRole("link", { name: "不安全链接" })).not.toBeInTheDocument();
    // A card that says nothing of who made it has no fold for it; and the card's own title is the page's, not an <h2> of the article.
    expect(container.querySelector("details")).toBeNull();
    expect(screen.queryByRole("heading", { level: 2 })).not.toBeInTheDocument();
    expect(screen.queryByText("学术证据")).not.toBeInTheDocument();
  });

  it("ends with the sources: nothing of the review, the discussion or the update record follows them", () => {
    const { container } = render(<EvidenceReading evidence={{ ...richCard, discussion: [{ author: "王医生", text: "有一个问题", createdAt: null }], revisions: [{ revision: 2, recordedAt: "2026-10-04T00:00:00Z", title: "新版", sourceFingerprint: "b", reviewStatus: null }, { revision: 1, recordedAt: "2026-10-01T00:00:00Z", title: "旧版", sourceFingerprint: "a", reviewStatus: null }] }} />);
    const headings = within(container).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
    expect(headings.at(-1)).toBe("来源与引用");
    expect(screen.queryByText("有一个问题")).not.toBeInTheDocument();
    expect(screen.queryByText("更新记录")).not.toBeInTheDocument();
    expect(screen.queryByText("AI 证据评议")).not.toBeInTheDocument();
  });

  it("folds who wrote and checked it under the answer, with the action that goes with the answer beside it", () => {
    const editorial: NonNullable<EvidenceCard["editorial"]> = {
      author: { kind: "ai", name: "EviMed 证据 AI", model: "deepseek-v4-flash" },
      lastEditor: { name: "李研究", editedAt: "2026-10-03T08:00:00Z" },
      reviewer: { kind: "ai", name: "独立核对 AI", model: "deepseek-v4-pro" },
      status: "ai-reviewed", reviewRevision: richCard.revision, reviewedAt: "2026-10-04T08:00:00Z", sourceCheckedAt: "2026-10-04T09:00:00Z",
    };
    const { container } = render(<EvidenceReading evidence={{ ...richCard, editorial, reviewer: "王药师", reviewedAt: "2026-10-04T08:00:00Z" }} afterAnswer={<button type="button">用这张卡继续研究</button>} />);
    const details = fold(container);
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(within(details).getByText("编写与核查")).toBeInTheDocument();
    expect(within(details).getByText("AI 编写 · EviMed 证据 AI")).toBeInTheDocument();
    expect(within(details).getByText(/用户修订记录 · 李研究/)).toBeInTheDocument();
    expect(within(details).getByText("评议者 王药师")).toBeInTheDocument();
    expect(within(details).getByText("AI 已评议")).toBeInTheDocument();
    expect(within(details).getByText(/评议于/)).toBeInTheDocument();
    expect(within(details).getByText(/全部来源上次核查于/)).toBeInTheDocument();
    // The disclosure of how the card was made is in the same fold, and no model is named anywhere on the page.
    expect(within(details).getByText("披露")).toBeInTheDocument();
    expect(container).not.toHaveTextContent(/deepseek|模型/i);
    // The action sits in the row directly after the answer, in front of the fold.
    const answer = screen.getByText("核心回答").closest("section")!;
    const row = answer.nextElementSibling!;
    expect(row).toContainElement(screen.getByRole("button", { name: "用这张卡继续研究" }));
    expect(row).toContainElement(details);
  });

  it("keeps what is wrong or unfinished above the fold, in warning colour: a source not re-read, a card waiting for its review", () => {
    const editorial: NonNullable<EvidenceCard["editorial"]> = {
      author: { kind: "ai", name: "EviMed 证据 AI" }, reviewer: null, status: "review-pending", reviewRevision: null,
      sourceChangedAt: "2026-10-04T00:00:00Z", sourceCheckedAt: "2026-10-03T00:00:00Z",
      sourceChecks: [{ sourceIndex: 1, status: "retained", attemptedAt: "2026-10-04T00:00:00Z", code: "web_read_unreadable" }],
    };
    const { container } = render(<EvidenceReading evidence={{ ...richCard, editorial }} />);
    const details = fold(container);
    const retained = screen.getByText(/部分来源本轮尚未完成复核/);
    const pending = screen.getByText(/依据来源更新于/);
    expect(pending).toHaveTextContent("等待复核");
    for (const line of [retained, pending]) {
      expect(details).not.toContainElement(line);
      expect(line).toHaveClass("text-warn");
    }
    // The same source change, settled, is a plain line in the fold and no longer a warning.
    const { container: settled } = render(<EvidenceReading evidence={{ ...richCard, editorial: { ...editorial, status: "ai-reviewed", reviewer: { kind: "ai", name: "核对 AI" }, reviewRevision: richCard.revision, sourceChecks: [] } }} />);
    expect(within(fold(settled)).getByText(/依据来源更新于/)).toBeInTheDocument();
  });

  it("says a retraction above everything, as an alert", () => {
    render(<EvidenceReading evidence={{ ...richCard, sources: [{ ...richCard.sources[0], publicationStatus: { kind: "retracted", notices: ["撤稿声明"] } }] }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("原有结论需要重新核查");
    expect(screen.getByRole("alert")).toHaveClass("text-warn");
  });

  it("says the day it was last updated, from the newest revision, else the day it was made", () => {
    expect(evidenceUpdatedAt({ createdAt: "2026-10-01T00:00:00Z", revisions: [{ revision: 2, recordedAt: "2026-10-05T00:00:00Z", title: "新", sourceFingerprint: null, reviewStatus: null }] })).toBe("2026-10-05T00:00:00Z");
    expect(evidenceUpdatedAt({ createdAt: "2026-10-01T00:00:00Z" })).toBe("2026-10-01T00:00:00Z");
    expect(evidenceUpdatedAt({})).toBeNull();
    render(<EvidenceReading evidence={{ ...richCard, createdAt: "2026-10-01T12:00:00Z" }} />);
    expect(screen.getByText(/^更新于 2026\/10\/1/)).toBeInTheDocument();
  });
});
