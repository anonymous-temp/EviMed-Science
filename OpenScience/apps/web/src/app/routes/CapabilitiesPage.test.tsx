import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilitiesPage, capabilityBrief } from "./CapabilitiesPage";
import { WebApiError } from "@/lib/apiClient";

const agents = [
  {
    id: "adr-analysis",
    version: "1.0.0",
    title: "Drug Safety Analysis",
    category: "Pharmacovigilance",
    description: "Mine adverse-event signals and synthesize safety evidence.",
    skill: "adr-analysis",
    estimatedMinutes: [20, 40] as [number, number],
    starterPrompts: ["Analyze cardiac safety signals associated with osimertinib."],
    requiredInputs: ["drug"],
    optionalInputs: ["uploadedFiles"],
    requiredTools: ["evimed_adr_signal_analysis"],
    optionalTools: [],
    dataSources: ["faers"],
    outputs: [
      { path: "safety-report.md", required: true },
      { path: "signal-table.csv", required: true },
      { path: "signal-chart.png", required: false },
    ],
    completionChecks: ["requiredOutputsExist"],
    runtimeAgent: "evimed-adr-analysis",
  },
  {
    id: "off-label-analysis",
    version: "1.0.0",
    title: "Off-label Use Analysis",
    category: "Evidence Synthesis",
    description: "Compare labels, guidelines, trials, and literature.",
    skill: "off-label-analysis",
    estimatedMinutes: [15, 35] as [number, number],
    starterPrompts: ["Assess an off-label indication in a defined population."],
    requiredInputs: ["drug", "proposedUse"],
    optionalInputs: ["uploadedFiles"],
    requiredTools: ["evimed_offlabel_evidence_packet"],
    optionalTools: [],
    dataSources: ["drug-labels"],
    outputs: [{ path: "off-label-report.md", required: true }],
    completionChecks: ["requiredOutputsExist"],
    runtimeAgent: "evimed-off-label-analysis",
  },
  {
    id: "meta-analysis",
    version: "1.0.0",
    title: "Automated Meta-Analysis",
    category: "Evidence Synthesis",
    description: "Run a traceable systematic review and meta-analysis.",
    skill: "meta-analysis",
    estimatedMinutes: [30, 180] as [number, number],
    starterPrompts: ["Conduct a systematic review and meta-analysis."],
    requiredInputs: ["topic"],
    optionalInputs: ["uploadedFiles", "analysisType"],
    requiredTools: ["evimed_meta_analysis"],
    optionalTools: [],
    dataSources: ["metaagent"],
    outputs: [
      { path: "meta-analysis-report.md", required: true },
      { path: "meta-analysis-run.json", required: true },
    ],
    completionChecks: ["requiredOutputsExist"],
    runtimeAgent: "evimed-meta-analysis",
  },
  {
    id: "peer-review",
    version: "1.0.0",
    title: "Peer Review",
    category: "Research Quality",
    description: "Review a manuscript.",
    skill: "peer-review",
    estimatedMinutes: [20, 120] as [number, number],
    starterPrompts: ["Review my manuscript."],
    requiredInputs: ["manuscript"],
    optionalInputs: [],
    requiredTools: [],
    optionalTools: [],
    dataSources: ["uploaded-files"],
    outputs: [{ path: "peer-review-report.md", required: true }],
    completionChecks: ["requiredOutputsExist"],
    runtimeAgent: "evimed-peer-review",
  },
];

function dispatchedRun(sessionId: string, text: string) {
  return {
    id: "run_dispatched",
    sessionId,
    status: "running",
    mode: "specialist",
    agentId: "adr-analysis",
    effectiveAgentId: "adr-analysis",
    question: text,
    routeReason: "题面要一份可追溯的安全性证据报告",
    estimatedMinutes: { min: 20, max: 40 },
    artifacts: [],
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
  };
}

const mocks = vi.hoisted(() => ({
  listWebResearchAgents: vi.fn(),
  putWebResearchSession: vi.fn(),
  dispatchWebAgentRun: vi.fn(),
  cancelWebAgentRun: vi.fn(),
  hasWebApi: true,
}));

// The error dictionary (`webErrorMessage`) lives in this module and the code
// under test calls it, so the real exports come through and only the calls
// this test drives are replaced.
vi.mock("@/lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  get hasWebApi() {
    return mocks.hasWebApi;
  },
  listWebResearchAgents: mocks.listWebResearchAgents,
  putWebResearchSession: mocks.putWebResearchSession,
  dispatchWebAgentRun: mocks.dispatchWebAgentRun,
  cancelWebAgentRun: mocks.cancelWebAgentRun,
  getWebProjectId: () => "default",
}));

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}{location.search}<span data-testid="intent">{JSON.stringify(location.state?.runtimeUiIntent)}</span></div>;
}

describe("CapabilitiesPage", () => {
  beforeEach(() => {
    mocks.listWebResearchAgents.mockReset();
    mocks.listWebResearchAgents.mockResolvedValue(agents);
    mocks.putWebResearchSession.mockReset();
    mocks.putWebResearchSession.mockImplementation(async (sessionId: string, selection: object) => ({ sessionId, ...selection }));
    mocks.dispatchWebAgentRun.mockReset();
    mocks.dispatchWebAgentRun.mockImplementation(async (sessionId: string, text: string) => dispatchedRun(sessionId, text));
    mocks.cancelWebAgentRun.mockReset();
    mocks.cancelWebAgentRun.mockImplementation(async (id: string) => ({ ...dispatchedRun("web-old", ""), id, status: "canceled" }));
    mocks.hasWebApi = true;
  });

  it("points desktop users to the hosted workspace instead of an empty catalog", () => {
    mocks.hasWebApi = false;
    render(
      <MemoryRouter initialEntries={["/agents"]}>
        <Routes>
          <Route path="/agents" element={<CapabilitiesPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText("科研能力仅在 EviMed 在线工作空间中可用")).toBeInTheDocument();
    expect(screen.getByText("请在 EviMed 在线工作空间中使用此功能。")).toBeInTheDocument();
    expect(mocks.listWebResearchAgents).not.toHaveBeenCalled();
  });

  it("shows a list skeleton while the catalog loads", () => {
    mocks.listWebResearchAgents.mockReturnValue(new Promise(() => {}));
    const { container } = render(
      <MemoryRouter>
        <CapabilitiesPage />
      </MemoryRouter>,
    );
    expect(container.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  // Appendix D §10.4: compact rows grouped by what they are for, a line icon
  // instead of the two-letter monogram, one line of what it does, how long.
  it("groups compact rows by category, in the product's words, without monograms", async () => {
    render(
      <MemoryRouter>
        <CapabilitiesPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { level: 1, name: "科研能力" })).toBeInTheDocument();
    const groups = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
    expect(groups).toEqual(["临床证据1 项", "写作与传播1 项", "药学评价2 项"]);
    const pharmacy = screen.getByRole("heading", { level: 2, name: /药学评价/ }).closest("section")!;
    expect(within(pharmacy).getByRole("button", { name: "药品安全性分析：查看说明并开始" })).toHaveTextContent("通常 20–40 分钟");
    expect(within(pharmacy).getByRole("button", { name: "超说明书用药分析：查看说明并开始" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "论文审稿：查看说明并开始" })).toHaveTextContent("需要你的资料");
    expect(screen.queryByText("SA")).not.toBeInTheDocument();
    expect(screen.queryByText("Drug Safety Analysis")).not.toBeInTheDocument();
  });

  it("filters by search, including example questions, and by category", async () => {
    render(
      <MemoryRouter>
        <CapabilitiesPage />
      </MemoryRouter>,
    );
    await screen.findByRole("button", { name: /药品安全性分析/ });

    await userEvent.type(screen.getByRole("searchbox", { name: "搜索科研能力" }), "氨甲环酸");
    expect(screen.getByRole("button", { name: /自动化 Meta 分析/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /药品安全性分析/ })).not.toBeInTheDocument();

    await userEvent.clear(screen.getByRole("searchbox", { name: "搜索科研能力" }));
    const filters = screen.getByRole("group", { name: "按分类筛选" });
    await userEvent.click(within(filters).getByRole("button", { name: "药学评价" }));
    expect(within(filters).getByRole("button", { name: "药学评价" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /药品安全性分析/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /自动化 Meta 分析/ })).not.toBeInTheDocument();
  });

  it("opens a model card: what it does, how well it has done, its limits and what you receive", async () => {
    render(
      <MemoryRouter>
        <CapabilitiesPage />
      </MemoryRouter>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "药品安全性分析：查看说明并开始" }));

    const card = screen.getByRole("dialog", { name: "药品安全性分析" });
    expect(card).toHaveTextContent("开展不良事件信号挖掘、说明书比对与安全性证据汇总。");
    // How well: from evals/ (the acceptance ledger), never estimated.
    expect(within(card).getByRole("heading", { name: "实测表现" })).toBeInTheDocument();
    expect(card).toHaveTextContent("最近一次真实交付（2026年9月4日）已通过验收。");
    expect(within(card).getByRole("heading", { name: "已知局限" })).toBeInTheDocument();
    expect(card).toHaveTextContent("报告数不等于发生率");
    expect(within(card).getByRole("heading", { name: "你会拿到" })).toBeInTheDocument();
    expect(card).toHaveTextContent("安全性证据报告");
    expect(within(card).getAllByRole("button", { name: /^开始：/ })).toHaveLength(3);

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens the card a link names", async () => {
    render(
      <MemoryRouter initialEntries={["/app/capabilities?capability=meta-analysis"]}>
        <CapabilitiesPage />
      </MemoryRouter>,
    );
    const card = await screen.findByRole("dialog", { name: "自动化 Meta 分析" });
    expect(card).toHaveTextContent("没有通过验收");
  });

  // Owner decision 3: a starter question starts a run when clicked — no plan
  // to approve first — and the route line says what the control plane decided.
  it("starts a starter question directly: binds a session, dispatches, and shows the route line", async () => {
    render(
      <MemoryRouter initialEntries={["/app/capabilities"]}>
        <CapabilitiesPage />
      </MemoryRouter>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "药品安全性分析：查看说明并开始" }));
    await userEvent.click(screen.getByRole("button", { name: "开始：分析奥希替尼相关的心脏安全性信号，并形成可追溯的证据报告。" }));

    await waitFor(() => expect(mocks.dispatchWebAgentRun).toHaveBeenCalled());
    const [sessionId, selection] = mocks.putWebResearchSession.mock.calls[0];
    expect(selection).toEqual({ mode: "specialist", agentId: "adr-analysis", agentVersion: "1.0.0" });
    expect(mocks.dispatchWebAgentRun.mock.calls[0][0]).toBe(sessionId);
    expect(mocks.dispatchWebAgentRun.mock.calls[0][1]).toBe("分析奥希替尼相关的心脏安全性信号，并形成可追溯的证据报告。");

    // The card closes; the receipt takes the focus, with the route line.
    const receipt = await screen.findByRole("heading", { name: /^已开始：/ });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const section = receipt.closest("section")!;
    expect(section.textContent).toContain("按 药品安全性分析 处理");
    expect(section.textContent).toContain("通常 20–40 分钟");
    expect(section.textContent).toContain("题面要一份可追溯的安全性证据报告");
  });

  it("starts the researcher's own question from the card", async () => {
    render(
      <MemoryRouter initialEntries={["/app/capabilities"]}>
        <CapabilitiesPage />
      </MemoryRouter>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "自动化 Meta 分析：查看说明并开始" }));
    await userEvent.type(screen.getByRole("textbox", { name: "你的问题" }), "他汀类药物与糖尿病新发风险");
    await userEvent.click(screen.getByRole("button", { name: "开始" }));

    await waitFor(() => expect(mocks.dispatchWebAgentRun).toHaveBeenCalled());
    expect(mocks.putWebResearchSession.mock.calls[0][1]).toEqual({ mode: "specialist", agentId: "meta-analysis", agentVersion: "1.0.0" });
    expect(mocks.dispatchWebAgentRun.mock.calls[0][1]).toBe("他汀类药物与糖尿病新发风险");
  });

  // A capability that works on the researcher's own material would begin by
  // asking for a file nobody gave it; its starter question goes into the box.
  it("puts a starter question into the box, not into a run, when the capability needs your material", async () => {
    render(
      <MemoryRouter initialEntries={["/app/capabilities"]}>
        <CapabilitiesPage />
      </MemoryRouter>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "论文审稿：查看说明并开始" }));
    const card = screen.getByRole("dialog", { name: "论文审稿" });
    expect(card).toHaveTextContent("开始前：需要先把稿件上传到知识库");
    await userEvent.click(within(card).getByRole("button", { name: /^放进问题框：审查我上传的论文/ }));

    expect(within(card).getByRole("textbox", { name: "你的问题" })).toHaveValue("审查我上传的论文，定位方法学、统计学、报告规范和完整性问题。");
    expect(within(card).getByRole("textbox", { name: "你的问题" })).toHaveFocus();
    expect(mocks.dispatchWebAgentRun).not.toHaveBeenCalled();
  });

  it("changes the line from the receipt: the run stops and the same question starts on the answer line", async () => {
    render(
      <MemoryRouter initialEntries={["/app/capabilities"]}>
        <CapabilitiesPage />
      </MemoryRouter>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "药品安全性分析：查看说明并开始" }));
    await userEvent.click(screen.getAllByRole("button", { name: /^开始：/ })[0]);
    await screen.findByRole("heading", { name: /^已开始：/ });

    mocks.dispatchWebAgentRun.mockImplementationOnce(async (sessionId: string, text: string) => ({
      ...dispatchedRun(sessionId, text),
      id: "run_answer",
      mode: "open-domain",
      agentId: null,
      effectiveAgentId: "open-domain-answer",
      routeReason: "这是一个可以直接回答的问题",
      estimatedMinutes: { min: 1, max: 3 },
    }));
    await userEvent.click(screen.getByRole("button", { name: "改为普通问答" }));

    await waitFor(() => expect(mocks.cancelWebAgentRun).toHaveBeenCalledWith("run_dispatched"));
    expect(mocks.putWebResearchSession.mock.calls[1][1]).toEqual({ mode: "open-domain" });
    // A new session: a binding cannot change once it exists.
    expect(mocks.putWebResearchSession.mock.calls[1][0]).not.toBe(mocks.putWebResearchSession.mock.calls[0][0]);
    expect(await screen.findByText("已改为按「普通问答」处理；原来那次研究已停止。")).toBeInTheDocument();
    expect(screen.getByText("普通问答", { selector: "strong" })).toBeInTheDocument();
  });

  it("says so when the router still claims the question after 普通问答 was asked for", async () => {
    render(
      <MemoryRouter initialEntries={["/app/capabilities"]}>
        <CapabilitiesPage />
      </MemoryRouter>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "药品安全性分析：查看说明并开始" }));
    await userEvent.click(screen.getAllByRole("button", { name: /^开始：/ })[0]);
    await screen.findByRole("heading", { name: /^已开始：/ });

    mocks.dispatchWebAgentRun.mockImplementationOnce(async (sessionId: string, text: string) => ({
      ...dispatchedRun(sessionId, text),
      id: "run_rerouted",
      mode: "open-domain",
      agentId: null,
      effectiveAgentId: "adr-analysis",
    }));
    await userEvent.click(screen.getByRole("button", { name: "改为普通问答" }));

    expect(await screen.findByText(/路由判断这个问题仍需要「药品安全性分析」/)).toBeInTheDocument();
  });

  it("says why a start failed, in place, and starts nothing", async () => {
    mocks.dispatchWebAgentRun.mockRejectedValueOnce(new WebApiError("HTTP 503", { status: 503, code: "runtime_unavailable" }));
    render(
      <MemoryRouter initialEntries={["/app/capabilities"]}>
        <CapabilitiesPage />
      </MemoryRouter>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "药品安全性分析：查看说明并开始" }));
    await userEvent.click(screen.getAllByRole("button", { name: /^开始：/ })[0]);

    expect(await screen.findByRole("alert")).toHaveTextContent("运行时出现问题，稍后重试。");
    expect(screen.getByRole("dialog", { name: "药品安全性分析" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^已开始：/ })).not.toBeInTheDocument();
  });

  it("can still put a brief that names the capability into the conversation, binding nothing (§9.8)", async () => {
    // The other way in: a template as a suggestion the orchestrator reads out
    // of the brief, not a package the session is married to — so the URL
    // carries no agent and the draft carries the capability by name.
    render(
      <MemoryRouter initialEntries={["/app/capabilities"]}>
        <Routes>
          <Route path="/app/capabilities" element={<CapabilitiesPage />} />
          <Route path="/app/chat" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "药品安全性分析：查看说明并开始" }));
    await userEvent.click(screen.getByRole("button", { name: "在对话里写" }));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/chat"));
    expect(mocks.putWebResearchSession).not.toHaveBeenCalled();
    expect(mocks.dispatchWebAgentRun).not.toHaveBeenCalled();
    expect(screen.getByTestId("location")).not.toHaveTextContent("agent=");
    const intent = JSON.parse(screen.getByTestId("intent").textContent!);
    expect(intent).toMatchObject({ kind: "create", projectId: "default" });
    expect(intent.sessionId).toBeTruthy();
    expect(intent.requestId).toBeTruthy();
    expect(intent.draft).toBe(capabilityBrief("药品安全性分析", "分析奥希替尼相关的心脏安全性信号，并形成可追溯的证据报告。"));
  });

  it("offers a retry when the catalogue could not be loaded, rather than a dead error line", async () => {
    mocks.listWebResearchAgents.mockRejectedValueOnce(
      new WebApiError("HTTP 503", { status: 503, code: "runtime_unavailable" }),
    );
    render(
      <MemoryRouter>
        <CapabilitiesPage />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("运行时出现问题，稍后重试。");

    mocks.listWebResearchAgents.mockResolvedValue(agents);
    await userEvent.click(screen.getByRole("button", { name: /重试/ }));
    expect(await screen.findByRole("button", { name: /药品安全性分析/ })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
