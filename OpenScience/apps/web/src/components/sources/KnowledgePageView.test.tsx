import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgePageViewData, SourceRecord } from "@/lib/sourceClient";
import { KnowledgePageView } from "./KnowledgePageView";

const mocks = vi.hoisted(() => ({ page: vi.fn(), locate: vi.fn(), note: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/sourceClient", async (importOriginal) => ({ ...(await importOriginal<object>()), getKnowledgePage: mocks.page, locateSourceQuote: mocks.locate,
  getSourceNote: mocks.note, saveSourceNote: mocks.save }));

const A = `src_${"a".repeat(32)}`;
const B = `src_${"b".repeat(32)}`;
const source = { id: `src_${"7".repeat(32)}`, projectId: "p1", payload: { paths: ["knowledge-base/wiki/afib.md"] }, display: { origin: "wiki", kind: "wiki", title: "抗凝治疗" } } as unknown as SourceRecord;

function view(overrides: Partial<KnowledgePageViewData> = {}): KnowledgePageViewData {
  return {
    sourceId: source.id, slug: "afib", type: "topic", title: "抗凝治疗",
    sections: [
      { heading: "房颤与肾病", items: [
        { kind: "claim", text: "口服抗凝是房颤卒中预防的基础。", status: "verified", claimKind: "direct", confidence: null, evidence: [{ sourceId: A, title: "房颤指南", quote: "口服抗凝为基础", status: "verified" }] },
        { kind: "claim", text: "两份资料都谈到抗凝药的使用前提。", status: "verified", claimKind: "synthesized", confidence: "moderate",
          evidence: [{ sourceId: A, title: "房颤指南", quote: "q1", status: "verified" }, { sourceId: B, title: "肾病抗凝", quote: "q2", status: "verified" }] },
        { kind: "claim", text: "这一句的原文改过了。", status: "unverified", claimKind: "direct", confidence: null, evidence: [{ sourceId: B, title: "肾病抗凝", quote: "已不在", status: "quote_not_found" }] },
        { kind: "claim", text: "我自己的一句话。", status: "unsupported", claimKind: "direct", confidence: null, evidence: [] },
      ] },
      { heading: "相关", items: [{ kind: "nav", links: [{ slug: "warfarin", title: "华法林", sourceId: `src_${"c".repeat(32)}` }, { slug: "nowhere", title: null, sourceId: null }] }] },
    ],
    counts: { claims: 4, verified: 2, unverified: 1, unsupported: 1 }, basis: "compiler", stale: [], held: [], heldCount: 0, sources: [],
    ...overrides,
  };
}

function Where() { const location = useLocation(); return <p data-testid="where">{location.pathname}{location.search}</p>; }
function renderView() {
  return render(<MemoryRouter><Routes><Route path="*" element={<><KnowledgePageView source={source} onSaved={vi.fn()} /><Where /></>} /></Routes></MemoryRouter>);
}

describe("KnowledgePageView", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.page.mockResolvedValue(view()); mocks.note.mockResolvedValue({ title: "抗凝治疗", body: "# 抗凝治疗" }); });
  afterEach(() => vi.restoreAllMocks());

  it("marks a sentence the platform confirmed, says of an unconfirmed one that its quotation was not found, and leaves the researcher's own sentence unmarked", async () => {
    renderView();
    expect(await screen.findByText("口服抗凝是房颤卒中预防的基础。")).toBeInTheDocument();
    expect(screen.getAllByRole("img", { name: "已核对" })).toHaveLength(2);
    expect(screen.getAllByRole("img", { name: "未能核对" })).toHaveLength(1);
    expect(screen.getAllByRole("img", { name: "我的补充" })).toHaveLength(1);
    expect(screen.getByText(/没能在原文里核对到这句引文/)).toBeInTheDocument();
    expect(screen.getByText("综合 · 方向一致")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /《房颤指南》/ })).toHaveLength(2);
  });

  it("opens the document at the quotation, and the document alone when the quotation can no longer be found", async () => {
    mocks.locate.mockResolvedValueOnce({ status: "verified", start: 12, end: 20, page: 3, textSha256: "d".repeat(64) });
    renderView();
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole("button", { name: /《房颤指南》/ }))[0]);
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe(`/app/files/${A}?tab=original&start=12&end=20&sha=${"d".repeat(64)}&page=3`));
    mocks.locate.mockResolvedValueOnce({ status: "quote_not_found", start: null, end: null, page: null, textSha256: null });
    await user.click(screen.getByRole("button", { name: /《肾病抗凝》 · 没能在原文里核对到这句引文/ }));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe(`/app/files/${B}?tab=original`));
  });

  it("links to the pages it names, says what a changed document did, and lists the sentences it could not confirm apart", async () => {
    mocks.page.mockResolvedValue(view({ stale: [{ sourceId: A, reason: "retracted" }, { sourceId: B, reason: "removed" }],
      held: [{ heading: "房颤与肾病", text: "这句话的引文不在任何资料里。", reasons: ["quote_not_found"] }], heldCount: 1 }));
    renderView();
    expect(await screen.findByRole("link", { name: "华法林" })).toHaveAttribute("href", `/app/files/src_${"c".repeat(32)}`);
    expect(screen.getByText("nowhere")).toBeInTheDocument();
    expect(screen.getByText("来源已撤回")).toBeInTheDocument();
    expect(screen.getByText("来源已删除")).toBeInTheDocument();
    const fold = screen.getByText("未能核对的 1 句").closest("details")!;
    expect(within(fold).getByText("这句话的引文不在任何资料里。")).toBeInTheDocument();
  });

  it("opens the page's text in the editor", async () => {
    renderView();
    await userEvent.setup().click(await screen.findByRole("button", { name: "编辑" }));
    expect(await screen.findByLabelText("正文")).toHaveValue("# 抗凝治疗");
  });
});
