import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilitiesPage } from "./CapabilitiesPage";
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

/** Where a row sent the reader, and with which tool on. */
function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">
      {location.pathname}
      <span data-testid="capability">{String(location.state?.capabilityId ?? "")}</span>
      <span data-testid="intent">{JSON.stringify(location.state?.runtimeUiIntent)}</span>
    </div>
  );
}

describe("CapabilitiesPage", () => {
  beforeEach(() => {
    mocks.listWebResearchAgents.mockReset();
    mocks.listWebResearchAgents.mockResolvedValue(agents);
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
    expect(screen.getByText("科研工具仅在 EviMed 在线工作空间中可用")).toBeInTheDocument();
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

  it("groups compact rows by category, in the product's words, without monograms", async () => {
    render(
      <MemoryRouter>
        <CapabilitiesPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { level: 1, name: "科研工具" })).toBeInTheDocument();
    const groups = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
    expect(groups).toEqual(["临床证据1 项", "写作与传播1 项", "药学评价2 项"]);
    const pharmacy = screen.getByRole("heading", { level: 2, name: /药学评价/ }).closest("section")!;
    expect(within(pharmacy).getByRole("button", { name: "用「药品安全性分析」开始一次对话" })).toHaveTextContent("通常 20–40 分钟");
    expect(screen.getByRole("button", { name: "用「论文审稿」开始一次对话" })).toHaveTextContent("需要你的资料");
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

    await userEvent.type(screen.getByRole("searchbox", { name: "搜索科研工具" }), "氨甲环酸");
    expect(screen.getByRole("button", { name: /自动化 Meta 分析/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /药品安全性分析/ })).not.toBeInTheDocument();

    await userEvent.clear(screen.getByRole("searchbox", { name: "搜索科研工具" }));
    const filters = screen.getByRole("group", { name: "按分类筛选" });
    await userEvent.click(within(filters).getByRole("button", { name: "药学评价" }));
    expect(within(filters).getByRole("button", { name: "药学评价" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /药品安全性分析/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /自动化 Meta 分析/ })).not.toBeInTheDocument();
  });

  // The drawer with its own question box is gone: a row opens the conversation
  // the reader was going to type in anyway, with that tool on.
  it("a row opens a new conversation carrying the tool, and asks nothing here", async () => {
    render(
      <MemoryRouter initialEntries={["/app/capabilities"]}>
        <Routes>
          <Route path="/app/capabilities" element={<CapabilitiesPage />} />
          <Route path="/app/chat" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "用「药品安全性分析」开始一次对话" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/app/chat");
    expect(screen.getByTestId("capability")).toHaveTextContent("adr-analysis");
    expect(JSON.parse(screen.getByTestId("intent").textContent!).kind).toBe("create");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("offers a retry when the catalogue could not be loaded, rather than a dead error line", async () => {
    mocks.listWebResearchAgents.mockRejectedValueOnce(new WebApiError(503, "service_unavailable", "later"));
    render(
      <MemoryRouter>
        <CapabilitiesPage />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("无法加载工具目录");
    mocks.listWebResearchAgents.mockResolvedValueOnce(agents);
    await userEvent.click(screen.getByRole("button", { name: /重试/ }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /药品安全性分析/ })).toBeInTheDocument();
  });
});
