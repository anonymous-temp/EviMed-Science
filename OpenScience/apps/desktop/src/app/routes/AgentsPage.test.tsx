import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentsPage } from "./AgentsPage";

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

describe("AgentsPage", () => {
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
          <Route path="/agents" element={<AgentsPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText("科研工作流仅在 EviMed 在线工作空间中可用")).toBeInTheDocument();
    expect(screen.getByText("请在 EviMed 在线工作空间中使用此功能。")).toBeInTheDocument();
    expect(mocks.listWebResearchAgents).not.toHaveBeenCalled();
  });

  it("shows a list skeleton while the catalog loads", () => {
    mocks.listWebResearchAgents.mockReturnValue(new Promise(() => {}));
    const { container } = render(
      <MemoryRouter>
        <AgentsPage />
      </MemoryRouter>,
    );
    expect(container.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  it("renders a compact vertical catalog with time, file support, outputs, and starter prompts", async () => {
    render(
      <MemoryRouter initialEntries={["/agents"]}>
        <Routes>
          <Route path="/agents" element={<AgentsPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "科研工作流" })).toBeInTheDocument();
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
        <AgentsPage />
      </MemoryRouter>,
    );
    await screen.findByText("药品安全性分析");

    await userEvent.type(screen.getByRole("searchbox", { name: "搜索科研工作流" }), "超说明书");
    expect(screen.queryByText("药品安全性分析")).not.toBeInTheDocument();
    expect(screen.getByText("超说明书用药分析")).toBeInTheDocument();

    await userEvent.clear(screen.getByRole("searchbox", { name: "搜索科研工作流" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "按分类筛选" }), "药物警戒");
    expect(screen.getByText("药品安全性分析")).toBeInTheDocument();
    expect(screen.queryByText("超说明书用药分析")).not.toBeInTheDocument();
  });

  it("opens the shared live-session route with a specialist draft selection", async () => {
    render(
      <MemoryRouter initialEntries={["/agents"]}>
        <Routes>
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/live" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    await userEvent.click(await screen.findByRole("button", { name: /打开药品安全性分析/ }));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/live?agent=adr-analysis"));
  });
});
