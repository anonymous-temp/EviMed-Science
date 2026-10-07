import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunFilePage } from "./RunFilePage";

const mocks = vi.hoisted(() => ({
  saveToKnowledgeBase: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  listWebAgentRuns: vi.fn(),
  readArtifact: vi.fn(),
  readClaimVerification: vi.fn(),
  openRunProject: vi.fn(),
}));

vi.mock("@/lib/sourceClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sourceClient")>()),
  saveToKnowledgeBase: mocks.saveToKnowledgeBase,
}));
vi.mock("@/lib/toast", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));

vi.mock("@/lib/runLocation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/runLocation")>()),
  openRunProject: mocks.openRunProject,
}));

vi.mock("@/lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  hasWebApi: true,
  listWebAgentRuns: mocks.listWebAgentRuns,
}));

vi.mock("@/lib/artifactFile", () => ({
  readArtifact: mocks.readArtifact,
  readClaimVerification: mocks.readClaimVerification,
  downloadArtifact: vi.fn(),
  previewUrl: vi.fn(),
}));

const REPORT = "deliverables/d1/clinical-evidence-report.md";
const MATRIX = "deliverables/d1/clinical-evidence-matrix.json";

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/app/runs/:runId/files/*" element={<RunFilePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listWebAgentRuns.mockResolvedValue([
    { id: "run_1", sessionId: "ses_1", status: "succeeded", title: "阿司匹林一级预防", titleSource: "question", model: "deepseek-flash",
      startedAt: "2026-09-17T02:00:00Z", finishedAt: "2026-09-17T02:30:00Z", artifacts: [REPORT, MATRIX], qualityNotices: [] },
  ]);
  mocks.readArtifact.mockImplementation(async (path: string) => {
    if (path === REPORT) return { path, mime: "text/markdown", encoding: "utf8", size: 1, data: "## 摘要\n\n结论 [1]<!-- claim:CLM-001 -->。" };
    if (path === MATRIX) return { path, mime: "application/json", encoding: "utf8", size: 1, data: JSON.stringify({ claims: [
      { claimId: "CLM-001", claim: "结论。", claimType: "direct", supportQuote: "the conclusion", sourceTitle: "Trial" },
    ] }) };
    return null;
  });
  mocks.readClaimVerification.mockResolvedValue(null);
  mocks.openRunProject.mockResolvedValue(false);
});

describe("RunFilePage", () => {
  it("opens a run's report in the reader, under the run's title, and opens the claim the fragment names", async () => {
    renderAt(`/app/runs/run_1/files/${REPORT}#CLM-001`);
    expect(await screen.findByRole("heading", { level: 1, name: "阿司匹林一级预防 · 证据分析报告" })).toBeInTheDocument();
    // Back into the conversation the file was written in, not into a ledger row.
    expect(screen.getByRole("link", { name: "返回对话" })).toHaveAttribute("href", "/app/chat/ses_1");
    const evidence = await screen.findByRole("dialog");
    expect(within(evidence).getByText("结论。")).toBeInTheDocument();
    expect(mocks.readArtifact).toHaveBeenCalledWith(REPORT, "workspace");
  });

  it("shows a matrix as its table, the check in the second column, and opens a claim in a drawer", async () => {
    mocks.readClaimVerification.mockResolvedValue({
      claims: [{ claimId: "CLM-001", claimType: "direct", status: "verified", sources: [{ artifactPath: null, status: "verified" }] }],
      counts: { verified: 1 },
    });
    renderAt(`/app/runs/run_1/files/${MATRIX}`);
    const table = await screen.findByRole("table", { name: "证据矩阵：1 条结论" });
    expect(within(table).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["结论", "核对", "内容", "来源", "类型"]);
    expect(await within(table).findByText("✓ 已核对")).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "搜索结论" })).toBeInTheDocument();
    await userEvent.click(within(table).getByText("结论。"));
    const drawer = await screen.findByRole("dialog", { name: "CLM-001" });
    expect(within(drawer).getByText("“the conclusion”")).toBeInTheDocument();
  });

  // The matrix is read first and its checks second: for that moment, and when they cannot be read, 「未核对」 is not what a row says.
  it("says 核对中 while the checks are being read and 暂无核对结果 when there are none to read", async () => {
    let arrive!: (value: unknown) => void;
    mocks.readClaimVerification.mockReturnValue(new Promise((resolve) => { arrive = resolve; }));
    const first = renderAt(`/app/runs/run_1/files/${MATRIX}`);
    const table = await screen.findByRole("table", { name: "证据矩阵：1 条结论" });
    expect(within(table).getByText("核对中")).toBeInTheDocument();
    expect(within(table).queryByText("未核对")).toBeNull();
    arrive(null);
    expect(await within(table).findByText("暂无核对结果")).toBeInTheDocument();
    expect(within(table).queryByText("未核对")).toBeNull();
    first.unmount();

    mocks.readClaimVerification.mockRejectedValue(new Error("offline"));
    renderAt(`/app/runs/run_1/files/${MATRIX}`);
    expect(await screen.findByText("暂无核对结果")).toBeInTheDocument();
    expect(screen.queryByText("未核对")).toBeNull();
  });

  it("refuses a path that leaves the workspace, and says what to do", async () => {
    renderAt("/app/runs/run_1/files/..%2F..%2Fetc%2Fpasswd");
    expect(await screen.findByText("这个地址没有指向文件")).toBeInTheDocument();
    expect(mocks.readArtifact).not.toHaveBeenCalled();
  });

  // A Feishu card links a run's report; the run may be in another project,
  // whose workspace holds the file. This project's "not here" is not shown
  // while the shell finds and moves to it.
  it("opens a run of another project in that project, without showing this one's miss", async () => {
    mocks.openRunProject.mockReturnValue(new Promise(() => {}));
    mocks.readArtifact.mockResolvedValue(null);
    renderAt(`/app/runs/run_other/files/${REPORT}`);
    expect(await screen.findByText("正在打开")).toBeInTheDocument();
    expect(mocks.openRunProject).toHaveBeenCalledWith("run_other");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("still reads the file when no project has its run", async () => {
    renderAt(`/app/runs/run_gone/files/${REPORT}`);
    expect(await screen.findByRole("heading", { level: 1, name: "证据分析报告" })).toBeInTheDocument();
    // The body renders, then re-renders once the claim check and the source
    // notices settle; the first text node found can be the one replaced.
    await waitFor(() => expect(screen.getByText(/结论/)).toBeInTheDocument());
    expect(mocks.openRunProject).toHaveBeenCalledWith("run_gone");
    expect(screen.queryByText("正在打开这次运行所在的项目…")).toBeNull();
  });

  it("says a file that cannot be read cannot be read", async () => {
    renderAt("/app/runs/run_1/files/deliverables/d1/missing.md");
    expect(await screen.findByRole("alert")).toHaveTextContent("无法读取此文件");
  });

  // The conversation's file card has its own 「存入知识库」; this page's header is the same action for a file opened on its own.
  it("keeps the file in the knowledge base from its header, and says what happened", async () => {
    mocks.saveToKnowledgeBase.mockResolvedValue({ path: "knowledge-base/chat/clinical-evidence-report-1a2b3c4d.md", duplicate: false, sourceId: "src_a" });
    renderAt(`/app/runs/run_1/files/${REPORT}`);
    await screen.findByRole("heading", { level: 1, name: /证据分析报告/ });
    await userEvent.click(screen.getByRole("button", { name: "存入知识库" }));
    await waitFor(() => expect(mocks.saveToKnowledgeBase).toHaveBeenCalledWith(REPORT));
    expect(mocks.toastSuccess).toHaveBeenCalledWith("已存入知识库，正在读取");
    mocks.saveToKnowledgeBase.mockResolvedValueOnce({ path: "x", duplicate: true, sourceId: "src_a" });
    await userEvent.click(screen.getByRole("button", { name: "存入知识库" }));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("这份文件已经在知识库里"));
    mocks.saveToKnowledgeBase.mockRejectedValueOnce(new Error("HTTP 415"));
    await userEvent.click(screen.getByRole("button", { name: "存入知识库" }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining("没能存入知识库")));
  });
});
