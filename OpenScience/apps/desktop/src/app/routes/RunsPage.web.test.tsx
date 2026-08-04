import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebAgentRun } from "@/lib/apiClient";
import { useUiStore } from "@/lib/store";
import { RunsPage } from "./RunsPage";

// The hosted ledger: RunsPage picks HostedRunsView when a web API exists
// outside Tauri. The command boundary is mocked; the UI under test is real.
const listWebAgentRuns = vi.fn();
vi.mock("@/lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  hasWebApi: true,
  listWebAgentRuns: () => listWebAgentRuns(),
}));

const downloadArtifact = vi.fn();
vi.mock("@/lib/artifactFile", () => ({
  openArtifactExternally: vi.fn(),
  downloadArtifact: (path: string, root?: string) => downloadArtifact(path, root),
}));

function webRun(overrides: Partial<WebAgentRun> = {}): WebAgentRun {
  const now = new Date().toISOString();
  return {
    id: "run-1",
    dispatchId: null,
    dispatchStatus: "accepted",
    sessionId: "ses-1",
    mode: "specialist",
    agentId: "meta-analysis",
    agentVersion: null,
    runtimeAgent: null,
    model: "deepseek-chat",
    status: "succeeded",
    createdAt: now,
    startedAt: now,
    finishedAt: now,
    durationMs: 65_000,
    errorCode: null,
    artifacts: ["output/report.docx"],
    ...overrides,
  };
}

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={["/runs"]}>
      <RunsPage />
    </MemoryRouter>,
  );

describe("RunsPage (hosted web)", () => {
  beforeEach(() => {
    listWebAgentRuns.mockReset();
    downloadArtifact.mockReset();
    useUiStore.setState({ composerDraft: null });
    listWebAgentRuns.mockResolvedValue([
      webRun(),
      webRun({
        id: "run-2",
        sessionId: "ses-2",
        mode: "open-domain",
        agentId: null,
        effectiveAgentId: "clinical-evidence-synthesis",
        effectiveAgentVersion: "1.0.0",
        effectiveRuntimeAgent: "evimed-clinical-evidence-synthesis",
        status: "failed",
        startedAt: new Date(Date.now() - 3_600_000).toISOString(),
        errorCode: "agent_timeout",
        artifacts: [],
      }),
    ]);
  });

  it("groups runs under sticky day labels and expands the newest with its recipe", async () => {
    renderPage();
    expect(await screen.findByText("run-1")).toBeInTheDocument();
    expect(screen.getByText("今天")).toBeInTheDocument();
    expect(screen.getByText("run-2")).toBeInTheDocument();
    expect(screen.getByText("开放域 · clinical-evidence-synthesis")).toBeInTheDocument();
    // The newest row is expanded: meta chips, actions, and its artifact.
    expect(screen.getByText("deepseek-chat")).toBeInTheDocument();
    // The agent names both the row tag and the expanded detail chip.
    expect(screen.getAllByText("meta-analysis").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("output/report.docx")).toBeInTheDocument();
  });

  it("filters by status via a facet chip", async () => {
    renderPage();
    await screen.findByText("run-1");
    await userEvent.click(screen.getByRole("button", { name: /失败/ }));
    await waitFor(() => expect(screen.queryByText("run-1")).not.toBeInTheDocument());
    expect(screen.getByText("run-2")).toBeInTheDocument();
    // The failed row explains itself in its expanded detail. It used to print
    // the raw code, which is a server term in the wrong language for a reader.
    expect(screen.getByText("运行超时，未能在时限内完成。")).toBeInTheDocument();
  });

  it("filters by debounced search over id, agent, model and artifacts", async () => {
    renderPage();
    await screen.findByText("run-1");
    await userEvent.type(screen.getByPlaceholderText(/搜索专项、模型、会话或产物文件/), "zzz-no-match");
    expect(await screen.findByText(/没有符合筛选条件的运行记录/)).toBeInTheDocument();
  });

  it("drafts the review prompt when 复查与复现 is clicked", async () => {
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /复查与复现/ }));
    const draft = useUiStore.getState().composerDraft;
    expect(draft).toContain("复查科研运行 `run-1`（meta-analysis）");
    expect(draft).toContain("不要重新编造缺失数据");
  });

  it("downloads an artifact through the web API when clicked", async () => {
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /output\/report\.docx/ }));
    expect(downloadArtifact).toHaveBeenCalledWith("output/report.docx", "workspace");
  });

  it("explains the empty state", async () => {
    listWebAgentRuns.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText(/尚无运行记录/)).toBeInTheDocument();
  });

  it("shows why a package was delivered unverified, and what is unverified about it", async () => {
    // The verdict was computed, stored and returned by the API, and rendered
    // nowhere — so a package delivered with named gaps looked exactly like a
    // clean one, and the reader had no way to know which figure to re-check.
    listWebAgentRuns.mockResolvedValue([webRun({
      verification: "unverified",
      qualityNotices: ["报告第 44 行的数字未与所引主张对应。"],
      artifacts: ["clinical-evidence-report.md"],
    })]);
    renderPage();
    expect(await screen.findByText(/已交付，但未完成核验/)).toBeInTheDocument();
    expect(screen.getByText(/产物可以照常下载和阅读/)).toBeInTheDocument();
    expect(screen.getByText("报告第 44 行的数字未与所引主张对应。")).toBeInTheDocument();
  });

  it("states a failure in the reader's language and keeps the code for support", async () => {
    listWebAgentRuns.mockResolvedValue([webRun({
      status: "failed",
      errorCode: "specialist_citation_invalid",
      artifacts: [],
    })]);
    renderPage();
    const verdict = await screen.findByText(/读者无法打开的引文地址/);
    expect(verdict).toBeInTheDocument();
    // The raw code stays reachable as a tooltip, not as the message.
    expect(verdict).toHaveAttribute("title", "错误码：specialist_citation_invalid");
    expect(screen.queryByText("specialist_citation_invalid")).not.toBeInTheDocument();
  });

  it("shows liveness on a run that legitimately takes tens of minutes", async () => {
    listWebAgentRuns.mockResolvedValue([webRun({
      status: "running",
      durationMs: null,
      finishedAt: null,
      observedToolCalls: 84,
      lastProgressAt: new Date(Date.now() - 120_000).toISOString(),
    })]);
    renderPage();
    expect(await screen.findByText(/已完成 84 次检索与工具调用/)).toBeInTheDocument();
  });
});
