import { render, screen, waitFor } from "@testing-library/react";
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

  it("renders a compact vertical catalog with time, file support, outputs, and starter prompts", async () => {
    render(
      <MemoryRouter initialEntries={["/agents"]}>
        <Routes>
          <Route path="/agents" element={<CapabilitiesPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "科研能力" })).toBeInTheDocument();
    expect(await screen.findByText("药品安全性分析")).toBeInTheDocument();
    expect(screen.getByText("超说明书用药分析")).toBeInTheDocument();
    expect(screen.getByText("自动化 Meta 分析")).toBeInTheDocument();
    expect(screen.getByText("SA")).toBeInTheDocument();
    expect(screen.getByText("OL")).toBeInTheDocument();
    expect(screen.getByText("MA")).toBeInTheDocument();
    expect(screen.queryByText("01")).not.toBeInTheDocument();
    expect(screen.queryByText("02")).not.toBeInTheDocument();
    expect(screen.getByText("约 20–40 分钟")).toBeInTheDocument();
    expect(screen.getAllByText("支持知识库资料")).toHaveLength(3);
    expect(screen.getAllByText("报告")).toHaveLength(3);
    expect(screen.getByText("表格")).toBeInTheDocument();
    expect(screen.getByText("图表")).toBeInTheDocument();
    expect(screen.getByText(/分析奥希替尼相关的心脏安全性信号/)).toBeInTheDocument();
  });

  it("filters by search and category without turning the catalog into cards", async () => {
    render(
      <MemoryRouter>
        <CapabilitiesPage />
      </MemoryRouter>,
    );
    await screen.findByText("药品安全性分析");

    await userEvent.type(screen.getByRole("searchbox", { name: "搜索科研能力" }), "超说明书");
    expect(screen.queryByText("药品安全性分析")).not.toBeInTheDocument();
    expect(screen.getByText("超说明书用药分析")).toBeInTheDocument();

    await userEvent.clear(screen.getByRole("searchbox", { name: "搜索科研能力" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "按分类筛选" }), "药物警戒");
    expect(screen.getByText("药品安全性分析")).toBeInTheDocument();
    expect(screen.queryByText("超说明书用药分析")).not.toBeInTheDocument();
  });

  // Owner decision 3: 开始 runs at once — no plan to approve first — and the
  // route line says what the control plane decided the moment it answers.
  it("starts a capability directly: binds a session to it, dispatches, and shows the route line", async () => {
    render(
      <MemoryRouter initialEntries={["/app/capabilities"]}>
        <CapabilitiesPage />
      </MemoryRouter>,
    );
    await userEvent.click(await screen.findByRole("button", { name: /使用药品安全性分析能力/ }));
    const question = screen.getByRole("textbox", { name: "你的问题" });
    expect(question).toHaveValue("分析奥希替尼相关的心脏安全性信号，并形成可追溯的证据报告。");
    await userEvent.click(screen.getByRole("button", { name: "开始" }));

    await waitFor(() => expect(mocks.dispatchWebAgentRun).toHaveBeenCalled());
    const [sessionId, selection] = mocks.putWebResearchSession.mock.calls[0];
    expect(selection).toEqual({ mode: "specialist", agentId: "adr-analysis", agentVersion: "1.0.0" });
    expect(mocks.dispatchWebAgentRun.mock.calls[0][0]).toBe(sessionId);
    expect(mocks.dispatchWebAgentRun.mock.calls[0][1]).toBe("分析奥希替尼相关的心脏安全性信号，并形成可追溯的证据报告。");

    const receipt = await screen.findByRole("heading", { name: /^已开始：/ });
    expect(receipt).toHaveFocus();
    const section = receipt.closest("section")!;
    expect(section.textContent).toContain("按 药品安全性分析 处理");
    expect(section.textContent).toContain("通常 20–40 分钟");
    expect(section.textContent).toContain("题面要一份可追溯的安全性证据报告");
  });

  it("changes the line from the receipt: the run stops and the same question starts on the answer line", async () => {
    render(
      <MemoryRouter initialEntries={["/app/capabilities"]}>
        <CapabilitiesPage />
      </MemoryRouter>,
    );
    await userEvent.click(await screen.findByRole("button", { name: /使用药品安全性分析能力/ }));
    await userEvent.click(screen.getByRole("button", { name: "开始" }));
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
    expect(await screen.findByText("已改为按「普通问答」处理；原来那次运行已停止。")).toBeInTheDocument();
    expect(screen.getByText("普通问答", { selector: "strong" })).toBeInTheDocument();
  });

  it("says so when the router still claims the question after 普通问答 was asked for", async () => {
    render(
      <MemoryRouter initialEntries={["/app/capabilities"]}>
        <CapabilitiesPage />
      </MemoryRouter>,
    );
    await userEvent.click(await screen.findByRole("button", { name: /使用药品安全性分析能力/ }));
    await userEvent.click(screen.getByRole("button", { name: "开始" }));
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
    await userEvent.click(await screen.findByRole("button", { name: /使用药品安全性分析能力/ }));
    await userEvent.click(screen.getByRole("button", { name: "开始" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("运行时出现问题，稍后重试。");
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
    await userEvent.click(await screen.findByRole("button", { name: /使用药品安全性分析能力/ }));
    await userEvent.click(screen.getByRole("button", { name: "在对话里写" }));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/chat"));
    expect(mocks.putWebResearchSession).not.toHaveBeenCalled();
    expect(mocks.dispatchWebAgentRun).not.toHaveBeenCalled();
    expect(screen.getByTestId("location")).not.toHaveTextContent("agent=");
    const intent = JSON.parse(screen.getByTestId("intent").textContent!);
    expect(intent).toMatchObject({ kind: "create", projectId: "default" });
    expect(intent.sessionId).toBeTruthy();
    expect(intent.requestId).toBeTruthy();
    const draft = intent.draft;
    expect(draft).toContain("药品安全性分析");
    expect(draft).toContain("分析奥希替尼相关的心脏安全性信号");
    expect(draft).toBe(capabilityBrief("药品安全性分析", "分析奥希替尼相关的心脏安全性信号，并形成可追溯的证据报告。"));
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
    expect(await screen.findByText("药品安全性分析")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
