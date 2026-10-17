import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvidenceReading, evidenceAuthoringRows, evidenceUpdatedAt } from "./EvidenceReading";
import type { EvidenceCard } from "@/lib/evidenceZoneClient";
import { card as richCard, programmeCard } from "./__fixtures__/evidenceCards";

const card: EvidenceCard = { id: "one", revision: 1, state: "published", canEdit: false, zoneId: "zone", body: "<script>untrusted</script>", title: "急诊证据", subtype: "academic", summary: "结论", creator: null, reviewer: null, reviewedAt: null, claims: [{ text: "证据结论 [1]" }], sources: [{ title: "不安全链接", url: "javascript:alert(1)", excerpt: "原文引句" }, { title: "论文", url: "https://example.org/paper", excerpt: null }], limitations: "样本较少", discussion: [], review: null, canResearch: true };

/** The one closed fold under the answer. */
const folds = (container: HTMLElement) => [...container.querySelectorAll("details")].filter((details) => !details.closest("[data-outline]"));
const fold = (container: HTMLElement) => folds(container)[0] as HTMLDetailsElement;

describe("evidence reading", () => {
  afterEach(() => vi.useRealTimers());
  it("preserves evidence/source/limitations without inventing author or grade", async () => {
    const { container } = render(<EvidenceReading evidence={card} />);
    expect(screen.getByText("样本较少")).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.queryByText(/创作者|审核者|学术评议/)).not.toBeInTheDocument();
    // A source is a row; its excerpt and the way to the original are read in the drawer. An address that is not http(s) is never a link.
    const sources = within(screen.getByRole("list", { name: "来源与引用" }));
    expect(screen.queryByText("原文引句")).not.toBeInTheDocument();
    await userEvent.click(sources.getByRole("button", { name: "不安全链接" }));
    const unsafe = screen.getByRole("dialog", { name: "来源 1" });
    expect(within(unsafe).getByText("原文引句")).toBeInTheDocument();
    expect(within(unsafe).queryByRole("link", { name: /打开原文/ })).not.toBeInTheDocument();
    await userEvent.click(within(unsafe).getByRole("button", { name: "关闭" }));
    await userEvent.click(sources.getByRole("button", { name: "论文" }));
    expect(within(screen.getByRole("dialog", { name: "来源 2" })).getByRole("link", { name: /打开原文/ })).toHaveAttribute("href", "https://example.org/paper");
    // A card that says nothing of who made it has no fold for it; and the card's own title is the page's, not an <h2> of the article
    // (the article's sections are the page's h2 since release 11, under its one h1).
    expect(folds(container)).toHaveLength(0);
    expect(screen.queryByRole("heading", { level: 2, name: "急诊证据" })).not.toBeInTheDocument();
    expect(screen.queryByText("学术证据")).not.toBeInTheDocument();
  });

  it("lists ten conclusions first and folds a long body, rendered as Markdown, under its heading (release-11 walk: 50 000 px)", async () => {
    const claims = Array.from({ length: 12 }, (_, index) => ({ ...richCard.claims[0], claimId: undefined, text: `第 ${index + 1} 条要点` }));
    const body = `## 已逐字核对的结论\n\n${Array.from({ length: 90 }, (_, index) => `${index + 1}. 结论 ${index + 1} 在这一人群中成立，来源 [${index + 1}]`).join("\n")}`;
    const { container } = render(<EvidenceReading evidence={{ ...richCard, claims, body }} />);
    expect(screen.getByText("第 10 条要点")).toBeInTheDocument();
    expect(screen.queryByText("第 11 条要点")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "显示更多 · 还有 2 条" }));
    expect(await screen.findByText("第 12 条要点")).toBeInTheDocument();
    const folded = [...container.querySelectorAll("details")].find((details) => /补充说明|证据正文/.test(details.querySelector("summary")?.textContent ?? ""));
    expect(folded).toBeDefined();
    expect(folded?.open).toBe(false);
    expect(folded?.textContent).not.toContain("##");
    expect(within(folded as HTMLElement).getByRole("heading", { name: "已逐字核对的结论" })).toBeInTheDocument();
  });

  it("ends with the sources: nothing of the review, the discussion or the update record follows them", () => {
    const { container } = render(<EvidenceReading evidence={{ ...richCard, discussion: [{ author: "王医生", text: "有一个问题", createdAt: null }], revisions: [{ revision: 2, recordedAt: "2026-10-04T00:00:00Z", title: "新版", sourceFingerprint: "b", reviewStatus: null }, { revision: 1, recordedAt: "2026-10-01T00:00:00Z", title: "旧版", sourceFingerprint: "a", reviewStatus: null }] }} />);
    const headings = within(container).getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
    expect(headings.at(-1)).toBe("来源与引用");
    expect(screen.queryByText("有一个问题")).not.toBeInTheDocument();
    expect(screen.queryByText("更新记录")).not.toBeInTheDocument();
    expect(screen.queryByText("AI 证据评议")).not.toBeInTheDocument();
  });

  it("folds who wrote and checked it under the answer, as the rows of one list, with the action that goes with the answer beside it", () => {
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
    const row = (label: string) => within(details).getByText(label).nextElementSibling;
    expect(row("出品方")).toHaveTextContent("李研究 · 用户 · 与所涉产品无利益关系");
    expect(row("性质")).toHaveTextContent("解读 · 综合");
    expect(row("编写")).toHaveTextContent("AI · EviMed 证据 AI");
    expect(row("用户修订")).toHaveTextContent(/^李研究 · /);
    expect(row("评议者")).toHaveTextContent("王药师");
    expect(within(details).getByText("评议于")).toBeInTheDocument();
    expect(within(details).getByText("来源核查")).toBeInTheDocument();
    expect(within(details).queryByText(/AI 已评议|AI 待评议/)).not.toBeInTheDocument();
    // How the card was made is in the same list, and no model is named anywhere on the page.
    expect(row("AI 做了")).toHaveTextContent("检索、筛选、抽取、综合");
    expect(within(details).getByText("生成于")).toBeInTheDocument();
    expect(container).not.toHaveTextContent(/deepseek|模型/i);
    // The action sits in the row directly after the answer, in front of the fold.
    const answer = screen.getByRole("heading", { name: "核心回答" }).closest("section")!;
    const after = answer.nextElementSibling!;
    expect(after).toContainElement(screen.getByRole("button", { name: "用这张卡继续研究" }));
    expect(after).toContainElement(details);
  });

  it("states what the AI did, the dates, who wrote it and who reviewed it, and never the name of the model", () => {
    const rows = evidenceAuthoringRows({ ...richCard, disclosure: { ...richCard.disclosure!, modelVersion: "2026-09", reviewers: [{ name: "王药师", title: "主管药师", affiliation: "某医院" }] } });
    const value = (label: string) => rows.find((entry) => entry.label === label)?.value;
    expect(value("AI 做了")).toBe("检索、筛选、抽取、综合");
    expect(value("作者")).toBe("李研究");
    expect(value("审核")).toBe("王药师，主管药师，某医院");
    expect(value("最后核对")).toBeDefined();
    expect(JSON.stringify(rows)).not.toMatch(/deepseek|2026-09/);
    expect(evidenceAuthoringRows({ ...richCard, producer: null, originality: null, creator: null, disclosure: null })).toEqual([]);
  });

  it("keeps what is wrong above the fold, in warning colour: a source that changed under the card — and says nothing of a source the upkeep did not re-read", () => {
    const editorial: NonNullable<EvidenceCard["editorial"]> = {
      author: { kind: "ai", name: "EviMed 证据 AI" }, reviewer: null, status: "review-pending", reviewRevision: null,
      sourceChangedAt: "2026-10-04T00:00:00Z", sourceCheckedAt: "2026-10-03T00:00:00Z",
      sourceChecks: [{ sourceIndex: 1, status: "retained", attemptedAt: "2026-10-04T00:00:00Z", code: "web_read_unreadable" }],
    };
    const { container } = render(<EvidenceReading evidence={{ ...richCard, editorial }} />);
    const details = fold(container);
    expect(container.textContent).not.toMatch(/部分来源本轮尚未完成复核|沿用上次保留内容/);
    const pending = screen.getByText(/依据来源更新于/);
    expect(pending).toHaveTextContent("等待复核");
    expect(details).not.toContainElement(pending);
    expect(pending).toHaveClass("text-warn");
    // The same source change, settled, is a row in the fold and no longer a warning.
    const { container: settled } = render(<EvidenceReading evidence={{ ...richCard, editorial: { ...editorial, status: "ai-reviewed", reviewer: { kind: "ai", name: "核对 AI" }, reviewRevision: richCard.revision, sourceChecks: [] } }} />);
    expect(within(fold(settled)).getByText("来源更新")).toBeInTheDocument();
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
    // Written the way the rest of the app writes a day (review L-7): 「10月1日」 this year, not Intl's 「2026/10/1」.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-10T08:00:00Z"));
    render(<EvidenceReading evidence={{ ...richCard, createdAt: "2026-10-01T12:00:00Z" }} />);
    expect(screen.getByText(/^更新于 10月1日/)).toBeInTheDocument();
  });
});
