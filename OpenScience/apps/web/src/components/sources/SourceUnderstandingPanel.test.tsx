import { act, render as renderBare, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { ReactElement } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { knownErrorCodeMessage } from "@evimed/domain";
import type { SourceUnderstanding, SourceUnderstandingResult } from "@/lib/sourceClient";
import { SourceUnderstandingPanel } from "./SourceUnderstandingPanel";

const mocks = vi.hoisted(() => ({ getSourceUnderstanding: vi.fn(), listSourceUnderstandingHistory: vi.fn(), projectId: "project-one" }));
// Only the request functions are replaced; `sourceFailureMessage` stays real so
// the failed-generation empty state is proved against the shared dictionary.
vi.mock("@/lib/sourceClient", async (importOriginal) => ({ ...(await importOriginal<object>()),
  getSourceUnderstanding: mocks.getSourceUnderstanding, listSourceUnderstandingHistory: mocks.listSourceUnderstandingHistory }));
// Partial: only the project identity is stubbed, so `productErrorMessage` runs
// against the real shared error text.
vi.mock("@/lib/apiClient", async (importOriginal) => ({ ...(await importOriginal<object>()), getWebProjectId: () => mocks.projectId }));

// The panel links to the research session with the router's Link, so it
// renders inside one.
const render = (ui: ReactElement) => renderBare(ui, { wrapper: MemoryRouter });

const anchor = { sourceId: "source-one", generation: 2, unitId: "chunk-1", start: 0, end: 8, quote: "记录研究纳入标准" };
const understanding: SourceUnderstanding = {
  id: "understanding-two", sourceId: "source-one", generation: 2, docType: "research-protocol", depth: "deep", schemaVersion: 1,
  createdAt: "2026-09-07T12:00:00Z", run: { id: "run-one", sessionId: "session one", dispatchId: "dispatch-one" },
  usage: { currency: "CNY", modelId: "deepseek-v4-pro", providerId: "deepseek", actualCost: 0.0123, inputTokens: 100, outputTokens: 20 },
  summary: "按预定标准进行文献筛选。", slots: {
    purpose: { state: "known", value: "明确纳入标准", evidence: [anchor] },
    limitations: { state: "unknown", reason: "资料没有说明实施局限。" },
  }, claims: [{ id: "claim-one", statement: "研究先登记纳入标准。", evidence: [anchor] }],
  methods: [{ id: "method-one", title: "双人筛选", description: "分别记录判断。", whenToUse: "文献筛选时", steps: ["登记标准", "独立筛选"],
    checks: ["核对分歧"], pitfalls: ["不要事后修改标准"], evidence: [anchor], status: "draft" }],
  omissionAudit: { status: "not_run", reason: "尚未完成问答遗漏审计。", omissionRate: null },
  units: [{ id: "chunk-1", unitType: "chunk", start: 0, end: 8, text: anchor.quote, status: "indexed_only" }],
};
const result = (status: SourceUnderstandingResult["status"] = "complete"): SourceUnderstandingResult => ({ sourceId: "source-one", generation: 2, depth: "deep", status, current: understanding });
const props = { projectId: "project-one", sourceId: "source-one", sourceName: "研究方案.docx", generation: 2, onClose: vi.fn() };

describe("SourceUnderstandingPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectId = "project-one";
    mocks.getSourceUnderstanding.mockResolvedValue(result());
    mocks.listSourceUnderstandingHistory.mockResolvedValue({ items: [], nextCursor: null });
  });
  afterEach(() => { vi.useRealTimers(); });

  it("reports an audited omission rate and names the units nothing covered, and keeps not_run distinct from zero", async () => {
    // A coverage percentage says which units parsed. The audit says which of
    // them nothing in the understanding actually represents — so "not audited"
    // and "audited, nothing missed" must never render the same way.
    const unaudited = render(<SourceUnderstandingPanel {...props} />);
    expect(await screen.findByText("遗漏尚未审计")).toBeInTheDocument();
    expect(unaudited.container.textContent).not.toMatch(/遗漏率/);
    unaudited.unmount();

    mocks.getSourceUnderstanding.mockResolvedValue({
      ...result(),
      current: {
        ...understanding,
        omissionAudit: {
          status: "audited", reason: "按确定性抽样核对。", omissionRate: 0.25,
          samples: [
            { unitId: "chunk-1", represented: true },
            { unitId: "chunk-2", represented: true },
            { unitId: "chunk-3", represented: true },
            { unitId: "chunk-4", represented: false, note: "讨论了停药后随访，理解里没有对应条目。" },
          ],
        },
      },
    });
    const audited = render(<SourceUnderstandingPanel {...props} />);
    await screen.findByText(understanding.summary);
    const text = () => audited.container.textContent ?? "";
    await waitFor(() => expect(text()).toMatch(/抽查 4 个片段，1 个未被理解覆盖/));
    expect(text()).toMatch(/遗漏率 25%/);
    // The note is what a researcher can check; the parser's unit id is not
    // theirs, so the gap is numbered in the list instead.
    expect(text()).toMatch(/未覆盖片段 1：讨论了停药后随访/);
    expect(text()).not.toMatch(/chunk-4/);
    expect(text()).not.toMatch(/遗漏尚未审计/);
  });

  it("shows anchored slots, unknown reasons, draft methods and actual cost, and no route into the background run", async () => {
    render(<SourceUnderstandingPanel {...props} />);
    expect(await screen.findByText(understanding.summary)).toBeInTheDocument();
    expect(screen.getByText("明确纳入标准")).toBeInTheDocument();
    expect(screen.getByText("资料没有说明实施局限。")).toBeInTheDocument();
    expect(screen.getByText("这些方法草稿还没有发布到方法胶囊。")).toBeInTheDocument();
    // Two decimals of yuan, not eight; the model and provider ids and the run
    // id are engine internals a researcher never needs to read past.
    expect(screen.getByText(/费用 ¥0\.01/)).toBeInTheDocument();
    expect(screen.queryByText(/deepseek-v4-pro|run-one|CNY/)).not.toBeInTheDocument();
    // The run happened in the account's background sources project; there is
    // no conversation of the researcher's to open.
    expect(screen.queryByRole("link", { name: "查看研究会话" })).not.toBeInTheDocument();
    expect(screen.getByText("遗漏尚未审计")).toBeInTheDocument();
    expect(screen.queryByText(/遗漏.*0%/)).not.toBeInTheDocument();
    await userEvent.click(screen.getAllByText("查看原文依据（1）")[0]);
    expect(screen.getAllByText(anchor.quote)[0]).toBeVisible();
    // Numbered for a researcher; the parser's unit id and offsets are support
    // material.
    expect(screen.getAllByText("原文片段 1")[0]).toBeVisible();
    expect(screen.queryByText(/解析文本.*0–8/)).not.toBeInTheDocument();
  });

  it("keeps previous generations in paginated history without presenting them as current", async () => {
    const previous = { ...understanding, id: "understanding-one", generation: 1, summary: "上一代的理解。" };
    mocks.getSourceUnderstanding.mockResolvedValue({ ...result("parsing"), generation: 3, current: null });
    mocks.listSourceUnderstandingHistory.mockResolvedValueOnce({ items: [understanding], nextCursor: "page-two" })
      .mockResolvedValueOnce({ items: [previous], nextCursor: null });
    render(<SourceUnderstandingPanel {...props} generation={3} />);
    expect(await screen.findByText("第 3 次分析的理解正在生成")).toBeInTheDocument();
    expect(screen.queryByText(understanding.summary)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "查看历史" }));
    await userEvent.click(await screen.findByRole("button", { name: /第 2 次分析/ }));
    expect(screen.getByText(understanding.summary)).toBeInTheDocument();
    expect(screen.getByText("历史理解 · 第 2 次分析")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "加载更多历史" }));
    expect(await screen.findByRole("button", { name: /第 1 次分析/ })).toBeInTheDocument();
    expect(mocks.listSourceUnderstandingHistory).toHaveBeenLastCalledWith("source-one", "page-two");
  });

  it("polls only active work and stops after completion", async () => {
    vi.useFakeTimers();
    mocks.getSourceUnderstanding.mockResolvedValueOnce({ ...result("parsing"), current: null }).mockResolvedValue(result());
    const view = render(<SourceUnderstandingPanel {...props} />);
    await act(async () => {});
    expect(mocks.getSourceUnderstanding).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(mocks.getSourceUnderstanding).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(mocks.getSourceUnderstanding).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("discards late responses for a different source or project", async () => {
    let resolveOld!: (value: SourceUnderstandingResult) => void;
    mocks.getSourceUnderstanding.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValueOnce({ ...result(), sourceId: "source-two", current: { ...understanding, sourceId: "source-two", summary: "另一个来源。" } });
    const view = render(<SourceUnderstandingPanel {...props} />);
    view.rerender(<SourceUnderstandingPanel {...props} sourceId="source-two" />);
    expect(await screen.findByText("另一个来源。")).toBeInTheDocument();
    await act(async () => { resolveOld(result()); });
    expect(screen.queryByText(understanding.summary)).not.toBeInTheDocument();
    let resolveProject!: (value: SourceUnderstandingResult) => void;
    mocks.getSourceUnderstanding.mockReturnValueOnce(new Promise(resolve => { resolveProject = resolve; }));
    view.rerender(<SourceUnderstandingPanel {...props} sourceId="source-three" />);
    mocks.projectId = "project-two";
    await act(async () => { resolveProject(result()); });
    expect(screen.queryByText(understanding.summary)).not.toBeInTheDocument();
  });

  it("shows recoverable errors and an honest index-only empty state", async () => {
    mocks.getSourceUnderstanding.mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce({ ...result(), depth: "index_only", current: null });
    render(<SourceUnderstandingPanel {...props} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("无法加载资料理解");
    await userEvent.click(screen.getByRole("button", { name: "重试加载理解" }));
    expect(await screen.findByText("此资料只建索引")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "查看历史" }));
    await waitFor(() => expect(screen.getByText("暂无历史理解")).toBeInTheDocument());
  });

  it("keeps a generation whose parse failed distinct from one that was never analysed", async () => {
    // Both used to render 「此代次尚无可用理解」, so a researcher could not tell a
    // dead parse from a queue and re-uploaded the file, paying for the parse a
    // second time. The source's own status separates them; the stored error code
    // names the cause, and the sentence comes from the one dictionary.
    mocks.getSourceUnderstanding.mockResolvedValue({ ...result("failed"), generation: 3, current: null });
    const failed = render(<SourceUnderstandingPanel {...props} generation={3}
      error={{ code: "source_unreadable", message: "Source analysis failed." }} />);
    expect(await screen.findByText("第 3 次分析解析失败，因此这一次没有理解结果")).toBeInTheDocument();
    expect(failed.container.textContent).toContain(knownErrorCodeMessage("source_unreadable") as string);
    expect(failed.container.textContent).toContain("原件仍在知识库里");
    // The stored English literal is never shown, and the old sentence must not
    // be what a failure falls back to.
    expect(failed.container.textContent).not.toMatch(/Source analysis failed/);
    expect(screen.queryByText("这一次分析尚无可用理解")).not.toBeInTheDocument();
    failed.unmount();

    // A failure the source row recorded without a code still says it failed.
    mocks.getSourceUnderstanding.mockResolvedValue({ ...result("failed"), generation: 3, current: null });
    const bare = render(<SourceUnderstandingPanel {...props} generation={3} />);
    expect(await screen.findByText("第 3 次分析解析失败，因此这一次没有理解结果")).toBeInTheDocument();
    expect(bare.container.textContent).toContain("系统没有记下这次失败的原因。");
    bare.unmount();

    // Nothing failed: the empty state is unchanged.
    mocks.getSourceUnderstanding.mockResolvedValue({ ...result("complete"), generation: 3, current: null });
    render(<SourceUnderstandingPanel {...props} generation={3} />);
    expect(await screen.findByText("这一次分析尚无可用理解")).toBeInTheDocument();
  });

  it("uses normalized UTF-16 offsets and does not present an unverifiable quote as source evidence", async () => {
    const evidence = { ...anchor, start: 102, end: 104, quote: "标准" };
    mocks.getSourceUnderstanding.mockResolvedValue({ ...result(), current: { ...understanding,
      slots: { purpose: { state: "known", value: "正确字符范围", evidence: [evidence] },
        checks: { state: "known", value: "失配引用", evidence: [{ ...evidence, start: 101 }] } },
      claims: [], methods: [], units: [{ id: "chunk-1", unitType: "chunk", start: 100, end: 104, text: "🔬标准", status: "indexed_only" }],
    } });
    render(<SourceUnderstandingPanel {...props} />);
    await screen.findByText("正确字符范围");
    const toggles = screen.getAllByText("查看原文依据（1）");
    await userEvent.click(toggles[0]);
    expect(screen.getByText("标准")).toBeVisible();
    await userEvent.click(toggles[1]);
    expect(screen.getByText("此原文片段暂不可用，请重新加载理解详情。")).toBeVisible();
  });

  it("pauses polling while the document is hidden and resumes active work when visible", async () => {
    vi.useFakeTimers();
    let hidden = false;
    const visibility = vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    mocks.getSourceUnderstanding.mockResolvedValue({ ...result("parsing"), current: null });
    const view = render(<SourceUnderstandingPanel {...props} />);
    await act(async () => {});
    hidden = true;
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(mocks.getSourceUnderstanding).toHaveBeenCalledTimes(1);
    hidden = false;
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(mocks.getSourceUnderstanding).toHaveBeenCalledTimes(2);
    view.unmount(); visibility.mockRestore();
  });
});
