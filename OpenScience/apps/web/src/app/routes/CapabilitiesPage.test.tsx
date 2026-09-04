import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilitiesPage, capabilityBrief } from "./CapabilitiesPage";
import { useUiStore } from "@/lib/store";

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

const mocks = vi.hoisted(() => ({
  listWebResearchAgents: vi.fn(),
  hasWebApi: true,
}));

vi.mock("@/lib/apiClient", () => ({
  get hasWebApi() {
    return mocks.hasWebApi;
  },
  listWebResearchAgents: mocks.listWebResearchAgents,
}));

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}{location.search}</div>;
}

describe("CapabilitiesPage", () => {
  beforeEach(() => {
    mocks.listWebResearchAgents.mockReset();
    mocks.listWebResearchAgents.mockResolvedValue(agents);
    mocks.hasWebApi = true;
    useUiStore.setState({ composerDraft: null });
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
    expect(screen.getByText("能力模板仅在 EviMed 在线工作空间中可用")).toBeInTheDocument();
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

    expect(await screen.findByRole("heading", { name: "能力模板" })).toBeInTheDocument();
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

    await userEvent.type(screen.getByRole("searchbox", { name: "搜索能力模板" }), "超说明书");
    expect(screen.queryByText("药品安全性分析")).not.toBeInTheDocument();
    expect(screen.getByText("超说明书用药分析")).toBeInTheDocument();

    await userEvent.clear(screen.getByRole("searchbox", { name: "搜索能力模板" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "按分类筛选" }), "药物警戒");
    expect(screen.getByText("药品安全性分析")).toBeInTheDocument();
    expect(screen.queryByText("超说明书用药分析")).not.toBeInTheDocument();
  });

  it("prefills a brief that names the capability, and binds nothing (§9.8)", async () => {
    // The change F1 makes here is what a click *means*. Under one composition a
    // template is a suggestion the orchestrator reads out of the brief, not a
    // package the session is married to — so the URL carries no agent and the
    // draft carries the capability by name.
    render(
      <MemoryRouter initialEntries={["/app/capabilities"]}>
        <Routes>
          <Route path="/app/capabilities" element={<CapabilitiesPage />} />
          <Route path="/app/chat" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    await userEvent.click(await screen.findByRole("button", { name: /使用药品安全性分析模板/ }));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/chat"));
    expect(screen.getByTestId("location")).not.toHaveTextContent("agent=");
    const draft = useUiStore.getState().composerDraft ?? "";
    expect(draft).toContain("药品安全性分析");
    expect(draft).toContain("分析奥希替尼相关的心脏安全性信号");
    expect(draft).toBe(capabilityBrief("药品安全性分析", "分析奥希替尼相关的心脏安全性信号，并形成可追溯的证据报告。"));
  });

  it("offers a retry when the catalogue could not be loaded, rather than a dead error line", async () => {
    mocks.listWebResearchAgents.mockRejectedValueOnce(new Error("HTTP 503"));
    render(
      <MemoryRouter>
        <CapabilitiesPage />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("HTTP 503");

    mocks.listWebResearchAgents.mockResolvedValue(agents);
    await userEvent.click(screen.getByRole("button", { name: /重试/ }));
    expect(await screen.findByText("药品安全性分析")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
