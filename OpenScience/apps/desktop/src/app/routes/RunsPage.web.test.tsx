import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
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
    // The failed row's error code shows in its expanded detail.
    expect(screen.getByText("agent_timeout")).toBeInTheDocument();
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
});
