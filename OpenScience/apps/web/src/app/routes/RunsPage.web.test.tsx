import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebAgentRun } from "@/lib/apiClient";
import { webRunOutcome } from "@/lib/runPresentation";
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

/** `unverifiedArtifacts` is the ledger field naming what a refused run wrote.
 *  It is landing on the server in parallel and is not on `WebAgentRun` yet;
 *  older records will not carry it at all, which the page must survive. */
function webRun(overrides: Partial<WebAgentRun> & { unverifiedArtifacts?: string[] } = {}): WebAgentRun {
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

/** The navigation the page performed, so a test can assert the draft reached
 *  the channel that reads it rather than a store nothing reads. */
function NavProbe() {
  const location = useLocation();
  return (
    <>
      <div data-testid="location">{location.pathname}</div>
      <div data-testid="nav-state">{JSON.stringify(location.state ?? null)}</div>
    </>
  );
}

const renderPage = (entry = "/app/runs") =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <RunsPage />
      <NavProbe />
    </MemoryRouter>,
  );

// A run the 15-minute stall detector killed. The suite used to use
// `agent_timeout`, a code apps/server/src emits nowhere — so it validated a
// key of the page's own private table while none of the codes production
// actually writes was covered anywhere.
const TIMED_OUT = "runtime_monitor_timeout";

describe("RunsPage (hosted web)", () => {
  beforeEach(() => {
    listWebAgentRuns.mockReset();
    downloadArtifact.mockReset();
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
        errorCode: TIMED_OUT,
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
    expect(await screen.findByTitle(`错误码：${TIMED_OUT}`)).toBeInTheDocument();
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
    expect(screen.getByTitle(`错误码：${TIMED_OUT}`)).toBeInTheDocument();
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

  /**
   * "复查与复现" used to write `composerDraft` and navigate. The only reader of
   * that store field is the unrouted `components/thread/Composer`, so the
   * draft went nowhere and the researcher landed on an empty runtime chat —
   * a button whose tooltip promised a drafted prompt and which did nothing.
   * The intent channel is the one that already ships and is already read.
   */
  it("hands 复查与复现 to the session surface that actually reads the draft", async () => {
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /复查与复现/ }));
    expect(screen.getByTestId("location")).toHaveTextContent("/app/chat/ses-1");
    const state = JSON.parse(screen.getByTestId("nav-state").textContent || "null");
    // `kind: "open"` on the run's own session: this is a review of that run,
    // not a fresh conversation about it.
    expect(state.runtimeUiIntent.kind).toBe("open");
    expect(state.runtimeUiIntent.sessionId).toBe("ses-1");
    expect(state.runtimeUiIntent.draft).toContain("复查科研运行 `run-1`（meta-analysis）");
    expect(state.runtimeUiIntent.draft).toContain("不要重新编造缺失数据");
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
    // How much is owed, before any of the prose: a reader must not have to
    // count bullets to learn there are three findings and one is blocking.
    expect(screen.getByText(/必须修正 1 项 · 建议修正 2 项/)).toBeInTheDocument();
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
    const failed = webRun({ status: "failed", errorCode: "specialist_citation_invalid", artifacts: [] });
    listWebAgentRuns.mockResolvedValue([failed]);
    renderPage();
    const verdict = await screen.findByTitle("错误码：specialist_citation_invalid");
    // One sentence, from the one dictionary, via the one projection.
    expect(verdict).toHaveTextContent(webRunOutcome(failed).headline);
    // The raw code stays reachable as a tooltip, not as the message.
    expect(verdict.textContent).not.toMatch(/specialist_citation_invalid/);
    expect(screen.queryByText("specialist_citation_invalid")).not.toBeInTheDocument();
  });

  /**
   * The single most damaging string this page shipped. `runErrorLabel` fell
   * back to "运行未通过核验。" for every code its 20-key table did not list,
   * and every code the monitor writes fell through — so a run killed on a
   * timer told the researcher their evidence had failed quality control.
   */
  it("never reports a timer kill as a quality-control failure", async () => {
    const timedOut = webRun({ id: "run-timeout", status: "failed", errorCode: TIMED_OUT, artifacts: [] });
    listWebAgentRuns.mockResolvedValue([timedOut]);
    renderPage();
    const verdict = await screen.findByTitle(`错误码：${TIMED_OUT}`);
    expect(verdict).toHaveTextContent(webRunOutcome(timedOut).headline);
    expect(verdict.textContent).not.toMatch(/核验/);
    // Chinese, not an identifier: a code that fell through the dictionary
    // would render as itself, which is a bug report and not a message.
    expect(verdict.textContent).toMatch(/[一-鿿]/);
    expect(screen.queryByText("运行未通过核验。")).not.toBeInTheDocument();
  });

  /**
   * 28 of 179 finished runs on the host were refused with an empty artifact
   * list while a complete package sat on disk — p90 58 minutes of work, the
   * most recent a nine-file clinical package. Nothing deleted those files.
   */
  it("hands back the files a refused run wrote, labelled as ungraded", async () => {
    listWebAgentRuns.mockResolvedValue([webRun({
      id: "run-refused",
      status: "failed",
      errorCode: "specialist_deliverable_not_accepted",
      artifacts: [],
      unverifiedArtifacts: ["deliverables/clinical-evidence-report.md", "deliverables/citation-ledger.csv"],
    })]);
    renderPage();
    expect(await screen.findByText(/未通过核验的文件（2）/)).toBeInTheDocument();
    expect(screen.getByText("deliverables/clinical-evidence-report.md")).toBeInTheDocument();
    // Never dressed as accepted work: the marker carries the same weight as
    // the path, because a refused package presented like an accepted one is
    // the failure the gate exists to prevent, moved into the UI.
    expect(screen.getAllByText("未经核验")).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: /clinical-evidence-report\.md/ }));
    expect(downloadArtifact).toHaveBeenCalledWith("deliverables/clinical-evidence-report.md", "workspace");
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
    // A run still working owes no verdict. `runOutcomeKind` calls a running
    // record with no code `unknown` — correctly, it is not an outcome — so the
    // row has to ask "is it over" before it asks "how did it go", or a healthy
    // 40-minute analysis is captioned 「这次没有完成」.
    expect(screen.queryByText(/这次没有完成/)).not.toBeInTheDocument();
  });
});
