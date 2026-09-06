import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SourcesPage } from "./SourcesPage";

const mocks = vi.hoisted(() => ({
  listSources: vi.fn(), overrideSource: vi.fn(), retrySource: vi.fn(), cancelSource: vi.fn(), removeSource: vi.fn(),
  browseOpenList: vi.fn(), importOpenListSource: vi.fn(),
  getSourceUnderstanding: vi.fn(), listSourceUnderstandingHistory: vi.fn(),
}));
const context = vi.hoisted(() => ({ projectId: "project-one" }));

vi.mock("@/lib/sourceClient", () => mocks);
vi.mock("@/lib/apiClient", () => ({
  getWebProjectId: () => context.projectId,
  WebApiError: class WebApiError extends Error {},
}));

const source = {
  id: "source-one", projectId: "project-one", revision: 3,
  payload: {
    paths: ["knowledge-base/研究方案.docx"], status: "needs_attention", docType: "research-protocol", depth: "deep",
    version: 2, generation: 3, reasons: ["The file name identifies a protocol, SOP or checklist."],
    valueVector: { profileValue: 0.7, methodValue: 0.9, knowledgeValue: 0.6, evidenceValue: 0.4, dataValue: 0.1 },
    coverage: { total: 20, accounted: 20, accountedPercent: 100, extracted: 18, indexedOnly: 0, noContent: 0, failed: 2, percent: 90, omissionRate: 0.1 },
    outputs: { summary: "A randomized research protocol.", facts: 8, methods: 2, artifactPath: "knowledge-base/.evimed-derived/source-one/index.md" },
  },
};

describe("SourcesPage", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    context.projectId = "project-one";
    mocks.listSources.mockResolvedValue({ items: [source], nextCursor: null });
    mocks.overrideSource.mockResolvedValue(source);
    mocks.retrySource.mockResolvedValue(source);
    mocks.cancelSource.mockResolvedValue(source);
    mocks.removeSource.mockResolvedValue(source);
    mocks.getSourceUnderstanding.mockResolvedValue({ sourceId: "source-one", generation: 3, depth: "deep", status: "needs_attention", current: null });
    mocks.listSourceUnderstandingHistory.mockResolvedValue({ items: [], nextCursor: null });
  });
  afterEach(() => { vi.useRealTimers(); });

  it("shows status, coverage, value reasons and derived outputs", async () => {
    render(<SourcesPage />);
    expect(await screen.findByRole("heading", { name: "资料整理台" })).toBeInTheDocument();
    expect(await screen.findByText("研究方案.docx")).toBeInTheDocument();
    expect(screen.getByText("解析处理成功 90% · 处理台账 100% · 失败单元 2/20")).toBeInTheDocument();
    expect(screen.getByText("理解遗漏尚未审计")).toBeInTheDocument();
    expect(screen.queryByText(/遗漏 10%/)).not.toBeInTheDocument();
    expect(screen.queryByText("事实 8 · 方法线索 2")).not.toBeInTheDocument();
    expect(screen.getByText(/protocol, SOP or checklist/)).toBeInTheDocument();
    expect(screen.getByText(/需要你看一下/)).toBeInTheDocument();
  });

  it("lets the researcher override type and depth with a reason", async () => {
    render(<SourcesPage />);
    await userEvent.click(await screen.findByRole("button", { name: "调整分析" }));
    await userEvent.selectOptions(screen.getByLabelText("资料类型"), "lecture-slides");
    await userEvent.selectOptions(screen.getByLabelText("分析深度"), "structured");
    await userEvent.type(screen.getByLabelText("调整原因"), "这是教学课件");
    await userEvent.click(screen.getByRole("button", { name: "保存并重新分析" }));
    await waitFor(() => expect(mocks.overrideSource).toHaveBeenCalledWith("source-one", {
      expectedRevision: 3, docType: "lecture-slides", depth: "structured", reason: "这是教学课件",
    }));
  });

  it("filters attention items and exposes retry and cancel actions", async () => {
    render(<SourcesPage />);
    await screen.findByText("研究方案.docx");
    await userEvent.click(screen.getByRole("radio", { name: "需要处理" }));
    await waitFor(() => expect(mocks.listSources).toHaveBeenLastCalledWith("project-one", { status: "needs_attention" }));
    await userEvent.click(screen.getByRole("button", { name: "重新分析" }));
    await waitFor(() => expect(mocks.retrySource).toHaveBeenCalledWith("source-one", 3));
  });

  it("shows an actionable empty and error state", async () => {
    mocks.listSources.mockResolvedValueOnce({ items: [], nextCursor: null });
    const { unmount } = render(<SourcesPage />);
    expect(await screen.findByText("还没有进入分析流程的资料")).toBeInTheDocument();
    unmount();
    mocks.listSources.mockRejectedValueOnce(new Error("offline"));
    render(<SourcesPage />);
    expect(await screen.findByText(/无法加载资料状态/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("opens the actual understanding and history endpoints from the source card", async () => {
    render(<SourcesPage />);
    await userEvent.click(await screen.findByRole("button", { name: "查看理解" }));
    expect(await screen.findByText("此代次尚无可用理解")).toBeInTheDocument();
    expect(mocks.getSourceUnderstanding).toHaveBeenCalledWith("source-one");
    await userEvent.click(screen.getByRole("button", { name: "查看历史" }));
    expect(await screen.findByText("暂无历史理解")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "关闭理解详情" }));
    expect(screen.queryByText("此代次尚无可用理解")).not.toBeInTheDocument();
  });

  it("preserves a correction draft while active polling advances processing state", async () => {
    const pending = { ...source, payload: { ...source.payload, status: "parsing" } };
    mocks.listSources.mockResolvedValueOnce({ items: [pending], nextCursor: null })
      .mockResolvedValue({ items: [{ ...source, revision: 4 }], nextCursor: null });
    render(<SourcesPage />);
    await userEvent.click(await screen.findByRole("button", { name: "调整分析" }));
    await userEvent.type(screen.getByLabelText("调整原因"), "保留我的调整说明");
    await userEvent.selectOptions(screen.getByLabelText("分析深度"), "structured");
    // Restart the visible-tab polling deadline under the deterministic clock.
    vi.useFakeTimers();
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(mocks.listSources).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("调整原因")).toHaveValue("保留我的调整说明");
    expect(screen.getByLabelText("分析深度")).toHaveValue("structured");
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(mocks.listSources).toHaveBeenCalledTimes(2);
  });

  it("discards a previous project's late inventory response", async () => {
    let resolveOld!: (value: unknown) => void;
    mocks.listSources.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValueOnce({ items: [], nextCursor: null });
    const view = render(<SourcesPage />);
    context.projectId = "project-two";
    view.rerender(<SourcesPage />);
    expect(await screen.findByText("还没有进入分析流程的资料")).toBeInTheDocument();
    await act(async () => { resolveOld({ items: [source], nextCursor: null }); });
    expect(screen.queryByText("研究方案.docx")).not.toBeInTheDocument();
    expect(mocks.listSources).toHaveBeenLastCalledWith("project-two", { status: "" });
  });
});
