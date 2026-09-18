import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError, type WebAgentRun } from "@/lib/apiClient";
import { webRunOutcome } from "@/lib/runPresentation";
import { RunsPage } from "./RunsPage";

// The hosted ledger: RunsPage picks HostedRunsView when a web API exists
// outside Tauri. The command boundary is mocked; the UI under test is real.
const listWebAgentRuns = vi.fn();
const reportWebDeliverableFeedback = vi.fn();
const fetchWebMe = vi.fn();
const fetchWebConnectors = vi.fn();
vi.mock("@/lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  hasWebApi: true,
  listWebAgentRuns: () => listWebAgentRuns(),
  reportWebDeliverableFeedback: (input: unknown) => reportWebDeliverableFeedback(input),
  fetchWebMe: () => fetchWebMe(),
  fetchWebConnectors: () => fetchWebConnectors(),
  // Read back per deliverable; nothing reported yet in these tests.
  listWebDeliverableFeedback: async () => [],
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
    fetchWebMe.mockReset();
    fetchWebConnectors.mockReset();
    fetchWebConnectors.mockResolvedValue([]);
    fetchWebMe.mockResolvedValue({ user: { id: "u1", name: "研究者" }, operator: false, project: { id: "default", name: "我的研究" }, projects: [] });
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

  it("opens a deliverable in place instead of only downloading it", async () => {
    // 2026-09-16 review, P2 #14: a run's output was a list of paths to download.
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "预览 report.docx" }));
    expect(await screen.findByRole("dialog", { name: "预览 report.docx" })).toBeInTheDocument();
    expect(downloadArtifact).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "预览 report.docx" })).toBeNull();
  });

  it("shows a running run's deliverables as steps, and a finished run without them", async () => {
    // 2026-09-16 review, P2 #14.
    listWebAgentRuns.mockResolvedValue([webRun({
      id: "run-live", status: "running", finishedAt: null, durationMs: null, artifacts: [], observedToolCalls: 12,
      planItems: [
        { id: "d1", title: "证据综述报告", status: "accepted", attempts: 1 },
        { id: "d2", title: "文献计量分析", status: "rejected", attempts: 2 },
        { id: "d3", title: "方法学附录", status: "planned", attempts: 0 },
      ],
    } as Partial<WebAgentRun>)]);
    renderPage();
    const steps = await screen.findByRole("list", { name: "交付进度" });
    expect(screen.getByText("1/3 件已交付")).toBeInTheDocument();
    expect(steps).toHaveTextContent("证据综述报告已通过");
    expect(steps).toHaveTextContent("文献计量分析需修改 · 第 2 次提交");
    expect(steps).toHaveTextContent("方法学附录待开始");
  });

  it("groups runs under sticky day labels and expands the newest with its recipe", async () => {
    renderPage();
    // Neither run recorded a brief, so each is titled by the capability that
    // produced it — in the product's words. The row used to lead with the run
    // id and tag it with a shouted `CLINICAL-EVIDENCE-SYNTHESIS` beside a
    // Chinese connective (2026-09-15 walk, D1/D2).
    expect(await screen.findByText("临床证据深度分析")).toBeInTheDocument();
    expect(screen.getByText("今天")).toBeInTheDocument();
    expect(screen.getByText(/开放域 · 临床证据深度分析/)).toBeInTheDocument();
    expect(screen.queryByText(/clinical-evidence-synthesis/i)).not.toBeInTheDocument();
    // A row whose title already is the capability's name does not say it a
    // second time in its tag (review B §3c, item 4).
    expect(screen.getAllByText("自动化 Meta 分析")).toHaveLength(1);
    // The file reads by its name; the folder stays beside it (U13).
    expect(screen.getByText("report.docx")).toBeInTheDocument();
    expect(screen.getByText("output")).toBeInTheDocument();
    // The model id, the session id and the run id are still here, behind one
    // labelled disclosure rather than as four chips on the open row.
    expect(screen.getByText("技术标识（供排查使用）")).toBeInTheDocument();
    expect(screen.getByText("deepseek-chat")).toBeInTheDocument();
    expect(screen.getByText("ses-1")).toBeInTheDocument();
  });

  // A ledger row from before the `question` column, with no capability either:
  // the last thing left is the id, and an id is the absence of a name.
  it("says a run recorded no brief instead of using its id as a title", async () => {
    listWebAgentRuns.mockResolvedValue([webRun({ agentId: null, question: null })]);
    renderPage();
    expect(await screen.findByText("未记录题面的运行")).toBeInTheDocument();
  });

  // Every link into this page names the run it means. Without honouring it a
  // link can only land on "the newest run", which is a different run by the
  // time someone opens it — and the sidebar's recent list is built out of
  // exactly these links.
  it("opens the run a ?run= link names, not the newest one", async () => {
    renderPage("/app/runs?run=run-2");
    await screen.findByText("临床证据深度分析");
    // run-2 is the older, failed run; its expanded detail is what proves the
    // link won over the default.
    expect(await screen.findByTitle(`错误码：${TIMED_OUT}`)).toBeInTheDocument();
    expect(screen.queryByText("output/report.docx")).not.toBeInTheDocument();
  });

  it("filters by status via a facet chip", async () => {
    renderPage();
    await screen.findByText("run-1");
    await userEvent.click(screen.getByRole("button", { name: /未完成/, pressed: false }));
    await waitFor(() => expect(screen.queryByText("run-1")).not.toBeInTheDocument());
    // The one surviving row, now expanded.
    expect(screen.getByText(/开放域 · 临床证据深度分析/)).toBeInTheDocument();
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
    // Said in the run's live status line, not only in its identifiers.
    expect(screen.getByRole("status")).toHaveTextContent("按核验意见修复中");
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
    await userEvent.type(screen.getByPlaceholderText(/搜索题目、能力或产物文件/), "zzz-no-match");
    expect(await screen.findByText(/没有符合筛选条件的运行记录/)).toBeInTheDocument();
  });

  /**
   * "复查与复现" used to write a store field only our own, never-routed
   * composer read (deleted with that surface), so the draft went nowhere and
   * the researcher landed on an empty runtime chat — a button whose tooltip
   * promised a drafted prompt and which did nothing. The intent channel is
   * the one the kernel's application actually reads.
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
    await userEvent.click(await screen.findByRole("button", { name: /^下载 report\.docx/ }));
    expect(downloadArtifact).toHaveBeenCalledWith("output/report.docx", "workspace");
  });

  it("explains the empty state and offers the way to start", async () => {
    listWebAgentRuns.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText("还没有运行记录")).toBeInTheDocument();
    expect(screen.queryByText(/python train\.py/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "新任务" })).toHaveAttribute("href", "/app/chat");
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
        "SAFETY — 临床实践要点第 12 行把呼叫急救的条件写成了服药后是否缓解。",
      ],
      artifacts: ["clinical-evidence-report.md"],
    })]);
    renderPage();
    expect(await screen.findByText(/已交付，但未完成核验/)).toBeInTheDocument();
    expect(screen.getByText(/产物可以照常下载和阅读/)).toBeInTheDocument();
    // How much is owed, before any of the prose: a reader must not have to
    // count bullets to learn there are four findings and one is about safety.
    expect(screen.getByText("临床安全 1 项 · 必须修改 1 项 · 提示 2 项")).toBeInTheDocument();
    // Three weights, safety first and never folded: its line is on screen.
    const safety = screen.getByRole("group", { name: "临床安全" });
    expect(safety).toHaveTextContent("临床实践要点第 12 行把呼叫急救的条件写成了服药后是否缓解。");
    const mustFix = screen.getByRole("group", { name: "必须修改" });
    expect(safety.compareDocumentPosition(mustFix) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(mustFix).toHaveTextContent("检索日志与运行记录");
    // Advice is folded under one quiet line, still counted.
    expect(screen.getByText(/提示 2 项 · 不影响交付/)).toBeInTheDocument();
    expect(screen.getByText("数字与所引主张不符")).toBeInTheDocument();
    // No sentence written for the agent reaches a researcher, prefixed or not.
    expect(screen.queryByText(/^SAFETY|^MUST FIX/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Report line 44/)).not.toBeInTheDocument();
    expect(screen.queryByText(/search log must exactly match/)).not.toBeInTheDocument();
    expect(screen.getByText(/句末的「依据」逐条标出/)).toBeInTheDocument();
  });

  it("renders structured findings by severity in Chinese, never their legacy sentence", async () => {
    listWebAgentRuns.mockResolvedValue([webRun({
      verification: "unverified",
      qualityNotices: [
        { code: "quote_not_found", check: "quote-bond", severity: "must-fix", title: "引文不在所引来源中", detail: "第 3 条结论的引文未在保存的原文中找到。", claimId: "CLM-003", text: "claims[2].supportQuote was not found in its preserved source artifact." },
        { code: "numeric_fact", severity: "advice", title: "数字未在所引原文中出现", text: "claims[52].claim numeric fact 6 is not present in its direct support." },
      ],
      artifacts: ["clinical-evidence-report.md"],
    })]);
    renderPage();
    expect(await screen.findByText("必须修改 1 项 · 提示 1 项")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "必须修改" })).toHaveTextContent("第 3 条结论的引文未在保存的原文中找到。");
    expect(screen.queryByText(/supportQuote|numeric fact/)).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "临床安全" })).not.toBeInTheDocument();
  });

  // Support still needs the sentence the run was sent; an operator can open it.
  it("keeps the raw text of an old finding behind a disclosure only an operator gets", async () => {
    fetchWebMe.mockResolvedValue({ user: { id: "op", name: "运维" }, operator: true, project: { id: "default", name: "我的研究" }, projects: [] });
    listWebAgentRuns.mockResolvedValue([webRun({
      verification: "unverified",
      qualityNotices: ["Something the frozen table does not know about."],
      artifacts: ["clinical-evidence-report.md"],
    })]);
    renderPage();
    expect(await screen.findByText(/技术原文 1 条（仅运维账号可见）/)).toBeInTheDocument();
    expect(screen.getByText("Something the frozen table does not know about.")).toBeInTheDocument();
  });

  // The banner named seven sources on every page; the row names the one this
  // run needed, and only when it stopped on it.
  it("names the one data source a failed run needed a credential for", async () => {
    listWebAgentRuns.mockResolvedValue([webRun({
      status: "failed",
      errorCode: "public_source_opengwas_credential_missing",
      artifacts: [],
    })]);
    renderPage();
    expect(await screen.findByText(/这次运行因缺少 OpenGWAS 的凭据没能继续/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "填写凭据" })).toHaveAttribute("href", "/app/account?tab=connectors");
  });

  it("says the time range in words", async () => {
    renderPage();
    await screen.findAllByRole("button", { name: /复查与复现/ });
    const range = screen.getByRole("radiogroup", { name: "时间范围" });
    expect(range).toHaveTextContent("全部时间24 小时7 天30 天");
    expect(range.textContent).not.toMatch(/24h|7d|30d/);
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
    expect(screen.getByText("clinical-evidence-report.md")).toBeInTheDocument();
    // Never dressed as accepted work: the marker carries the same weight as
    // the path, because a refused package presented like an accepted one is
    // the failure the gate exists to prevent, moved into the UI.
    expect(screen.getAllByText("未经核验")).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: /^下载 clinical-evidence-report\.md/ }));
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
    expect(screen.getByText("技术标识（供排查使用）")).toBeInTheDocument();
    expect(screen.getByText("run-1")).toBeInTheDocument();
    expect(screen.getByText("ses-1")).toBeInTheDocument();
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

describe("deliverable feedback — the learning loop's first producer", () => {
  // Until 2026-09-16 `POST /api/feedback/events` and `reportWebDeliverableFeedback`
  // both existed and nothing called either: production held 92 feedback events,
  // all of them memory inferences being accepted, and zero deliverable events.
  // The method library was empty because nobody could say a deliverable was
  // good, not because nothing was.
  it("records an adoption against the run and the file", async () => {
    listWebAgentRuns.mockResolvedValue([webRun({ id: "run_1", artifacts: ["deliverables/report.md"] })]);
    render(<MemoryRouter><RunsPage /></MemoryRouter>);
    await userEvent.click(await screen.findByRole("button", { name: "采纳" }));
    await waitFor(() => expect(reportWebDeliverableFeedback).toHaveBeenCalledWith({
      trigger: "deliverable-adopted",
      runId: "run_1",
      path: "deliverables/report.md",
      summary: undefined,
    }));
    expect(await screen.findByText("已记录：这份成果被采纳。")).toBeInTheDocument();
  });

  it("asks what changed, because an edit with no reason distils to nothing", async () => {
    listWebAgentRuns.mockResolvedValue([webRun({ id: "run_1", artifacts: ["deliverables/report.md"] })]);
    render(<MemoryRouter><RunsPage /></MemoryRouter>);
    await userEvent.click(await screen.findByRole("button", { name: "我改过" }));
    const submit = screen.getByRole("button", { name: "提交" });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText("改了什么？一句话即可"), "把剂量表换成了指南的口径");
    await userEvent.click(submit);
    await waitFor(() => expect(reportWebDeliverableFeedback).toHaveBeenCalledWith({
      trigger: "deliverable-edited",
      runId: "run_1",
      path: "deliverables/report.md",
      summary: "把剂量表换成了指南的口径",
    }));
  });

  it("a refusal is a Chinese sentence and the buttons come back", async () => {
    listWebAgentRuns.mockResolvedValue([webRun({ id: "run_1", artifacts: ["deliverables/report.md"] })]);
    reportWebDeliverableFeedback.mockRejectedValue(
      new WebApiError("nope", { status: 503, code: "runtime_unavailable" }),
    );
    render(<MemoryRouter><RunsPage /></MemoryRouter>);
    await userEvent.click(await screen.findByRole("button", { name: "采纳" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("运行时出现问题，稍后重试。");
    expect(screen.getByRole("button", { name: "采纳" })).toBeEnabled();
  });
});
