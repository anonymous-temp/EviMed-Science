import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceUnderstanding, SourceUnderstandingResult } from "@/lib/sourceClient";
import { SourceUnderstandingPanel } from "./SourceUnderstandingPanel";

const mocks = vi.hoisted(() => ({ getSourceUnderstanding: vi.fn(), listSourceUnderstandingHistory: vi.fn(), projectId: "project-one" }));
vi.mock("@/lib/sourceClient", () => ({ getSourceUnderstanding: mocks.getSourceUnderstanding, listSourceUnderstandingHistory: mocks.listSourceUnderstandingHistory }));
vi.mock("@/lib/apiClient", () => ({ getWebProjectId: () => mocks.projectId, WebApiError: class extends Error {} }));

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
    await waitFor(() => expect(text()).toMatch(/抽查 4 个单元，1 个未被理解覆盖/));
    expect(text()).toMatch(/遗漏率 25%/);
    expect(text()).toMatch(/未覆盖单元 chunk-4：讨论了停药后随访/);
    expect(text()).not.toMatch(/遗漏尚未审计/);
    // the three represented units are not listed as gaps
    expect(text()).not.toMatch(/未覆盖单元 chunk-1/);
  });

  it("shows anchored slots, unknown reasons, draft methods, actual cost and the existing session route", async () => {
    render(<SourceUnderstandingPanel {...props} />);
    expect(await screen.findByText(understanding.summary)).toBeInTheDocument();
    expect(screen.getByText("明确纳入标准")).toBeInTheDocument();
    expect(screen.getByText("资料没有说明实施局限。")).toBeInTheDocument();
    expect(screen.getByText("方法草稿尚未发布为胶囊技能。" )).toBeInTheDocument();
    expect(screen.getByText(/实际费用.*¥0.0123/)).toBeInTheDocument();
    expect(screen.getByText(/deepseek-v4-pro/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看研究会话" })).toHaveAttribute("href", "/app/chat/session%20one");
    expect(screen.getByText("遗漏尚未审计")).toBeInTheDocument();
    expect(screen.queryByText(/遗漏.*0%/)).not.toBeInTheDocument();
    await userEvent.click(screen.getAllByText("查看原文依据（1）")[0]);
    expect(screen.getAllByText(anchor.quote)[0]).toBeVisible();
    expect(screen.getAllByText(/解析文本.*0–8/)[0]).toBeVisible();
  });

  it("keeps previous generations in paginated history without presenting them as current", async () => {
    const previous = { ...understanding, id: "understanding-one", generation: 1, summary: "上一代的理解。" };
    mocks.getSourceUnderstanding.mockResolvedValue({ ...result("parsing"), generation: 3, current: null });
    mocks.listSourceUnderstandingHistory.mockResolvedValueOnce({ items: [understanding], nextCursor: "page-two" })
      .mockResolvedValueOnce({ items: [previous], nextCursor: null });
    render(<SourceUnderstandingPanel {...props} generation={3} />);
    expect(await screen.findByText("第 3 代理解正在生成")).toBeInTheDocument();
    expect(screen.queryByText(understanding.summary)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "查看历史" }));
    await userEvent.click(await screen.findByRole("button", { name: /第 2 代/ }));
    expect(screen.getByText(understanding.summary)).toBeInTheDocument();
    expect(screen.getByText("历史理解 · 第 2 代")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "加载更多历史" }));
    expect(await screen.findByRole("button", { name: /第 1 代/ })).toBeInTheDocument();
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
