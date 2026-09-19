import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunFilePage } from "./RunFilePage";

const mocks = vi.hoisted(() => ({
  listWebAgentRuns: vi.fn(),
  readArtifact: vi.fn(),
  readClaimVerification: vi.fn(),
  openRunProject: vi.fn(),
}));

vi.mock("@/lib/runLocation", () => ({ openRunProject: mocks.openRunProject }));

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
    expect(screen.getByRole("link", { name: "运行记录" })).toHaveAttribute("href", "/app/runs?run=run_1");
    const evidence = await screen.findByRole("dialog");
    expect(within(evidence).getByText("结论。")).toBeInTheDocument();
    expect(mocks.readArtifact).toHaveBeenCalledWith(REPORT, "workspace");
  });

  it("shows a matrix as its table", async () => {
    renderAt(`/app/runs/run_1/files/${MATRIX}`);
    expect(await screen.findByRole("table", { name: "证据矩阵：1 条主张" })).toBeInTheDocument();
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
    expect(await screen.findByText("正在打开这次运行所在的项目…")).toBeInTheDocument();
    expect(mocks.openRunProject).toHaveBeenCalledWith("run_other");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("still reads the file when no project has its run", async () => {
    renderAt(`/app/runs/run_gone/files/${REPORT}`);
    expect(await screen.findByRole("heading", { level: 1, name: "证据分析报告" })).toBeInTheDocument();
    expect(await screen.findByText(/结论/)).toBeInTheDocument();
    expect(mocks.openRunProject).toHaveBeenCalledWith("run_gone");
    expect(screen.queryByText("正在打开这次运行所在的项目…")).toBeNull();
  });

  it("says a file that cannot be read cannot be read", async () => {
    renderAt("/app/runs/run_1/files/deliverables/d1/missing.md");
    expect(await screen.findByRole("alert")).toHaveTextContent("这个文件读不出来");
  });
});
