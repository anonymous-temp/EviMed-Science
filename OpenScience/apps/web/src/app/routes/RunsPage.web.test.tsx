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

const renderPage = (entry = "/app/runs") =>
  render(
    <MemoryRouter initialEntries={[entry]}>
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

  // Every link into this page names the run it means. Without honouring it a
  // link can only land on "the newest run", which is a different run by the
  // time someone opens it — and the sidebar's recent list is built out of
  // exactly these links.
  it("opens the run a ?run= link names, not the newest one", async () => {
    renderPage("/app/runs?run=run-2");
    await screen.findByText("run-2");
    // run-2 is the older, failed run; its expanded detail is what proves the
    // link won over the default.
    expect(await screen.findByText("运行超时，未能在时限内完成。")).toBeInTheDocument();
    expect(screen.queryByText("output/report.docx")).not.toBeInTheDocument();
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

  it("groups a delivered-but-unresolved run under 待人工复核, not under 成功", async () => {
    // `phase` is the projection (§7.1.1), not the ledger's own `status` — a
    // degraded run is still `status: "succeeded"`, so a chip keyed on status
    // could never find it. Filtering has to read the field the design actually
    // put this distinction in.
    listWebAgentRuns.mockResolvedValue([
      webRun({ id: "run-clean", status: "succeeded", phase: "accepted" }),
      webRun({ id: "run-degraded", status: "succeeded", phase: "degraded", verification: "unverified" }),
    ]);
    renderPage();
    await screen.findByText("run-clean");
    const chip = screen.getByRole("button", { name: /待人工复核/ });
    await userEvent.click(chip);
    await waitFor(() => expect(screen.queryByText("run-clean")).not.toBeInTheDocument());
    expect(screen.getByText("run-degraded")).toBeInTheDocument();
  });

  it("says which phase an open run is in, not only that it is running", async () => {
    // The projection was already on the wire and read by exactly one filter
    // chip; the row itself never mentioned it, so "已排队，尚未派发" and
    // "按门禁意见修复中" both rendered as 执行中 for as long as they lasted.
    listWebAgentRuns.mockResolvedValue([webRun({ id: "run-repairing", status: "running", phase: "repairing" })]);
    renderPage();
    await screen.findByText("run-repairing");
    expect(screen.getByText("按门禁意见修复中")).toBeInTheDocument();
  });

  it("does not show the 待人工复核 chip when nothing needs it", async () => {
    listWebAgentRuns.mockResolvedValue([webRun({ status: "succeeded", phase: "accepted" })]);
    renderPage();
    await screen.findByText("run-1");
    expect(screen.queryByRole("button", { name: /待人工复核/ })).not.toBeInTheDocument();
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
      qualityNotices: [
        "Report line 44 numeric facts 1.26-1.38 are not present in the cited claim evidence. Cite the claim that carries them.",
        "Report line 86 numeric facts 2.71 are not present in the cited claim evidence. Cite the claim that carries them.",
        "MUST FIX — The search log must exactly match successful evidence-search calls from the same run.",
      ],
      artifacts: ["clinical-evidence-report.md"],
    })]);
    renderPage();
    expect(await screen.findByText(/已交付，但未完成核验/)).toBeInTheDocument();
    expect(screen.getByText(/产物可以照常下载和阅读/)).toBeInTheDocument();
    // Grouped and named in Chinese, with what must be fixed leading. The notices
    // are written for the agent that repairs them; a reader meets the shape of
    // the problem first and the validator prose second.
    const mustFix = screen.getByText("必须修正");
    expect(mustFix).toBeInTheDocument();
    expect(screen.getByText("检索日志与运行记录")).toBeInTheDocument();
    expect(screen.getByText("数字与所引主张不符")).toBeInTheDocument();
    // Two notices of one kind are one heading carrying a count, not two walls.
    expect(screen.getByText("2")).toBeInTheDocument();
    // The severity marker is not left glued to the sentence.
    expect(screen.queryByText(/^MUST FIX/)).not.toBeInTheDocument();
    // The specifics a reader checks survive.
    expect(screen.getByText(/Report line 44 numeric facts 1\.26-1\.38/)).toBeInTheDocument();
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

  it("identifies a run by the question asked, keeping the id reachable", async () => {
    // The row led with run_cf7f08fa4b78…, so a list of thirty analyses was a
    // list of thirty hashes and telling them apart meant opening each.
    listWebAgentRuns.mockResolvedValue([webRun({
      question: "速效救心丸开封后多久失效？",
    })]);
    renderPage();
    expect(await screen.findByText("速效救心丸开封后多久失效？")).toBeInTheDocument();
    expect(screen.getByTitle("运行 ID")).toHaveTextContent("run-1");
  });

  it("finds a run by what was asked, not only by its id", async () => {
    listWebAgentRuns.mockResolvedValue([
      webRun({ question: "速效救心丸开封后多久失效？" }),
      webRun({ id: "run-other", question: "可穿戴设备检出房颤后如何处置？" }),
    ]);
    renderPage();
    await screen.findByText("速效救心丸开封后多久失效？");
    await userEvent.type(screen.getByPlaceholderText(/搜索/), "房颤");
    await waitFor(() => expect(screen.queryByText("速效救心丸开封后多久失效？")).not.toBeInTheDocument());
    expect(screen.getByText("可穿戴设备检出房颤后如何处置？")).toBeInTheDocument();
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
