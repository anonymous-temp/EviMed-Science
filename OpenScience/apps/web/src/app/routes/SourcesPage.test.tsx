import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SourcesPage } from "./SourcesPage";

const mocks = vi.hoisted(() => ({
  listSources: vi.fn(), overrideSource: vi.fn(), retrySource: vi.fn(), cancelSource: vi.fn(), removeSource: vi.fn(),
}));

vi.mock("@/lib/sourceClient", () => mocks);
vi.mock("@/lib/apiClient", () => ({ getWebProjectId: () => "project-one" }));

const source = {
  id: "source-one", projectId: "project-one", revision: 3,
  payload: {
    paths: ["knowledge-base/研究方案.docx"], status: "needs_attention", docType: "research-protocol", depth: "deep",
    version: 2, reasons: ["The file name identifies a protocol, SOP or checklist."],
    valueVector: { profileValue: 0.7, methodValue: 0.9, knowledgeValue: 0.6, evidenceValue: 0.4, dataValue: 0.1 },
    coverage: { total: 20, accounted: 20, extracted: 18, indexedOnly: 0, noContent: 0, failed: 2, percent: 100, omissionRate: 0.1 },
    outputs: { summary: "A randomized research protocol.", facts: 8, methods: 2, artifactPath: "knowledge-base/.evimed-derived/source-one/index.md" },
  },
};

describe("SourcesPage", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.listSources.mockResolvedValue({ items: [source], nextCursor: null });
    mocks.overrideSource.mockResolvedValue(source);
    mocks.retrySource.mockResolvedValue(source);
    mocks.cancelSource.mockResolvedValue(source);
    mocks.removeSource.mockResolvedValue(source);
  });

  it("shows status, coverage, value reasons and derived outputs", async () => {
    render(<SourcesPage />);
    expect(await screen.findByRole("heading", { name: "资料整理台" })).toBeInTheDocument();
    expect(await screen.findByText("研究方案.docx")).toBeInTheDocument();
    expect(screen.getByText("覆盖 100% · 遗漏 10%")).toBeInTheDocument();
    expect(screen.getByText("事实 8 · 方法线索 2")).toBeInTheDocument();
    expect(screen.getByText(/protocol, SOP or checklist/)).toBeInTheDocument();
    expect(screen.getByText("需要你看一下")).toBeInTheDocument();
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
    await userEvent.click(screen.getByRole("button", { name: "需要处理" }));
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
});
