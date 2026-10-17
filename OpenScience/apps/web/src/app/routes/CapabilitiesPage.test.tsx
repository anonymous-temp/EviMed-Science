import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CAPABILITY_DISPLAY, RESEARCH_TOOLS_NAME, SIMULATED_WALLET_LABEL, SIMULATED_WALLET_PAGES } from "@evimed/domain";
import { CapabilitiesPage } from "./CapabilitiesPage";
import { WebApiError } from "@/lib/apiClient";
import { forgetResearchBilling } from "@/lib/useResearchBilling";

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


const mocks = vi.hoisted(() => ({
  listWebResearchAgents: vi.fn(),
  listWebResearchSessions: vi.fn(),
  putWebResearchSession: vi.fn(),
  allowance: vi.fn(),
  estimates: vi.fn(),
}));

// The error dictionary (`webErrorMessage`) lives in this module and the code
// under test calls it, so the real exports come through and only the calls
// this test drives are replaced.
vi.mock("@/lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  listWebResearchAgents: mocks.listWebResearchAgents,
  listWebResearchSessions: mocks.listWebResearchSessions,
  putWebResearchSession: mocks.putWebResearchSession,
  fetchWebResearchAllowance: mocks.allowance,
  fetchWebResearchEstimates: mocks.estimates,
  getWebProjectId: () => "default",
}));

const NO_LINKS = { rechargeUrl: null, membershipUrl: null, ordersUrl: null, refundsUrl: null };
/** `/api/account/allowance` on a deployment that does not bill research — every deployment but one — as the server writes it. */
const billingOff = {
  enabled: false, simulated: false, currency: "CNY", status: "disabled", available: null, held: null, balances: null, membership: null,
  lowThreshold: null, month: { since: "2026-10-01T00:00:00.000Z", paid: 0, pending: 0 }, commerce: NO_LINKS,
};
/** …on one whose wallet is simulated, and on one whose wallet is real. */
const simulatedWallet = {
  ...billingOff, enabled: true, simulated: true, status: "ready", available: 200, lowThreshold: 20,
  commerce: { ...NO_LINKS, rechargeUrl: SIMULATED_WALLET_PAGES.recharge },
};
const realWallet = { ...simulatedWallet, simulated: false, lowThreshold: null, commerce: NO_LINKS };
/** …and from a control plane older than the simulated wallet: billing on, nothing left, and no word of simulation. */
const olderWallet = { enabled: true, currency: "CNY", status: "ready", available: 0, held: null, month: billingOff.month, commerce: NO_LINKS };

const estimate = (capabilityId: string, low: number | null, high: number | null, basis = "history") => ({
  capabilityId, basis, low, high, samples: basis === "history" ? 5 : 0, binding: false,
});
/** `/api/account/allowance/estimates` for the four tools: a range, a single figure, no basis — and one tool it does not answer for. */
const estimates = {
  currency: "CNY", simulated: true,
  items: [estimate("adr-analysis", 4, 8), estimate("off-label-analysis", 3, 3, "manifest"), estimate("meta-analysis", null, null, "none")],
};

/** Where a card sent the reader, and with which tool on. */
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

function renderPage() {
  return render(
    <MemoryRouter>
      <CapabilitiesPage />
    </MemoryRouter>,
  );
}

/** The button that opens a tool, by its name… */
const tool = (title: string) => screen.getByRole("button", { name: title });
/** …and the row it is the title of, which is what says how long the tool takes. */
const card = (title: string) => tool(title).closest("li")!;

describe("CapabilitiesPage", () => {
  beforeEach(() => {
    mocks.listWebResearchAgents.mockReset();
    mocks.listWebResearchAgents.mockResolvedValue(agents);
    mocks.listWebResearchSessions.mockReset();
    mocks.listWebResearchSessions.mockResolvedValue([]);
    mocks.putWebResearchSession.mockReset();
    mocks.putWebResearchSession.mockImplementation(async (sessionId: string, selection: object) => ({ sessionId, ...selection }));
    // Research billing is off unless a test says otherwise: every deployment but one.
    mocks.allowance.mockReset();
    mocks.allowance.mockResolvedValue(billingOff);
    mocks.estimates.mockReset();
    mocks.estimates.mockResolvedValue(estimates);
    forgetResearchBilling();
  });

  // 循证 GEO has its own row in the sidebar; its capabilities are not tools
  // one picks here, whatever the catalogue lists.
  it("offers no 循证 GEO capability", async () => {
    mocks.listWebResearchAgents.mockResolvedValue([
      ...agents,
      { ...agents[0], id: "geo-content", title: "GEO 答案引擎优化", category: "写作与传播" },
      { ...agents[0], id: "geo-insight", title: "GEO 洞察", category: "写作与传播" },
    ]);
    renderPage();
    await screen.findByRole("button", { name: /药品安全性分析/ });
    expect(screen.queryByText("GEO 答案引擎优化")).not.toBeInTheDocument();
    expect(screen.queryByText("GEO 洞察")).not.toBeInTheDocument();
  });

  it("shows the list's shape while the catalogue loads", async () => {
    mocks.listWebResearchAgents.mockReturnValue(new Promise(() => {}));
    const { container } = renderPage();
    expect(container.querySelector(".animate-pulse")).toBeInTheDocument();
    // The deployment's answer about billing lands meanwhile, and changes nothing here.
    await act(async () => {});
    expect(container.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  // 2026-10-14: the page is 科研工具 again (the owner's own name for the medical professional workflows), the controls are one
  // toolbar above the list they control, and the header is the title and nothing else.
  it("is titled 科研工具, with the search in the one toolbar above the list and no sentence under the title", async () => {
    renderPage();
    const heading = await screen.findByRole("heading", { level: 1, name: "科研工具" });
    expect(RESEARCH_TOOLS_NAME).toBe("科研工具");
    const search = screen.getByRole("searchbox", { name: "搜索工具" });
    expect(search).toHaveAttribute("placeholder", "搜索工具");
    expect(heading.closest("header")?.querySelectorAll("p")).toHaveLength(0);
    expect(heading.closest("header")?.querySelector("input")).toBeNull();
    // Control over content: the toolbar, with the search and the categories in it, comes before the first row.
    const toolbar = screen.getByRole("group", { name: "科研工具筛选" });
    expect(toolbar).toContainElement(search);
    expect(toolbar).toContainElement(screen.getByRole("group", { name: "分类" }));
    await screen.findByRole("button", { name: /药品安全性分析/ });
    expect(toolbar.compareDocumentPosition(tool("药品安全性分析")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(/选一项工具/)).not.toBeInTheDocument();
  });

  // 2026-10-07 plan §6: the page is the grid. The capability map is the evolution engine's own model (a task family by a capability,
  // nearly all of it 「尚未验证」) and the evolution panel is an operator's; neither belongs under a researcher's page, and with
  // them gone there is no tab strip and no tab named like the page.
  it("is one grid: no tab strip, no capability map and no evolution panel under it", async () => {
    renderPage();
    await screen.findByRole("button", { name: /药品安全性分析/ });
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    for (const gone of ["能力地图", "进化工具", "循证进化", "尚未验证", "待明确"]) expect(screen.queryByText(gone)).not.toBeInTheDocument();
  });

  // 2026-10-14: the page lists the medical professional workflows and nothing else — no 「通用」 group and no card for
  // documents, sheets, slides, data, the web or code, which are what the assistant does in any conversation.
  it("lists the professional workflows by category, each one sentence and how long it usually takes, and no general tool", async () => {
    renderPage();
    await screen.findByRole("button", { name: /药品安全性分析/ });
    // The categories in the product's order, not the order the catalogue came in, and a count after each.
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["临床证据", "药学评价", "写作与传播"]);
    const evidence = screen.getByRole("heading", { level: 2, name: "临床证据" }).closest("section")!;
    expect(within(evidence).getAllByRole("button").map((button) => button.textContent)).toEqual(["自动化 Meta 分析"]);
    const pharmacy = screen.getByRole("heading", { level: 2, name: "药学评价" }).closest("section")!;
    expect(within(pharmacy).getAllByRole("button").map((button) => button.textContent)).toEqual(["药品安全性分析", "超说明书用药分析"]);
    expect(within(pharmacy).getByText("2")).toBeInTheDocument();
    const safety = card("药品安全性分析");
    // The whole sentence, never cut to 「…」 by the row.
    expect(safety).toHaveTextContent(CAPABILITY_DISPLAY["adr-analysis"].description);
    expect(safety).toHaveTextContent("约 20～40 分钟");
    expect(safety.innerHTML).not.toMatch(/truncate|line-clamp/);
    // What a tool needs from the researcher is the composer's to say, not the row's.
    expect(card("论文审稿")).not.toHaveTextContent("需要你的资料");
    for (const general of ["文档", "表格", "幻灯片", "数据分析", "网页调研", "代码"]) {
      expect(screen.queryByRole("button", { name: general })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole("heading", { name: /通用|医学专业/ })).not.toBeInTheDocument();
    expect(screen.queryByText("SA")).not.toBeInTheDocument();
    expect(screen.queryByText("Drug Safety Analysis")).not.toBeInTheDocument();
  });

  it("filters by search, including example questions, and by category, in one row of chips", async () => {
    renderPage();
    await screen.findByRole("button", { name: /药品安全性分析/ });

    await userEvent.type(screen.getByRole("searchbox", { name: "搜索工具" }), "氨甲环酸");
    expect(screen.getByRole("button", { name: /自动化 Meta 分析/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /药品安全性分析/ })).not.toBeInTheDocument();

    await userEvent.type(screen.getByRole("searchbox", { name: "搜索工具" }), "不存在的工具");
    expect(await screen.findByText("没有符合条件的科研工具")).toBeInTheDocument();
    // An empty answer to a filter is a recipe: the one button that lets go of it.
    const empty = screen.getByText("没有符合条件的科研工具").closest("[data-empty]") as HTMLElement;
    await userEvent.click(within(empty).getByRole("button", { name: "清除筛选" }));
    expect(screen.getByRole("searchbox", { name: "搜索工具" })).toHaveValue("");
    expect(screen.getByRole("button", { name: /药品安全性分析/ })).toBeInTheDocument();

    const filters = screen.getByRole("group", { name: "分类" });
    // One row: the four categories of the display table, none a tool group of the product's own.
    expect(within(filters).getAllByRole("button").map((chip) => chip.textContent)).toEqual(["全部", "临床证据", "药学评价", "写作与传播"]);
    await userEvent.click(within(filters).getByRole("button", { name: "药学评价" }));
    expect(within(filters).getByRole("button", { name: "药学评价" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /药品安全性分析/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /自动化 Meta 分析/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "临床证据" })).not.toBeInTheDocument();
    await userEvent.click(within(filters).getByRole("button", { name: "临床证据" }));
    expect(screen.getByRole("button", { name: /自动化 Meta 分析/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /药品安全性分析/ })).not.toBeInTheDocument();
  });

  it("says how many tools it lists in the toolbar, and the count follows the filter", async () => {
    renderPage();
    await screen.findByRole("button", { name: /药品安全性分析/ });
    const toolbar = screen.getByRole("group", { name: "科研工具筛选" });
    expect(toolbar).toHaveTextContent("4 个");
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索工具" }), "氨甲环酸");
    expect(toolbar).toHaveTextContent("1 个");
  });

  // The two module names the owner replaced on 2026-10-07 keep finding the tools that carry the new ones until
  // 2027-01-07 (`@evimed/domain` retiredNames), and the old name is never shown back.
  it("finds a tool by a module's retired name, as its current name", async () => {
    mocks.listWebResearchAgents.mockResolvedValue([
      ...agents,
      // An id the display table does not know keeps its own record, so the sentence under test is the one written here.
      { ...agents[0], id: "custom-tool", title: "公共数据差异分析", category: "临床证据", description: "取公共 GEO 系列做两组差异表达，与循证 GEO 无关。", starterPrompts: ["分析一个公共数据集。"] },
    ]);
    renderPage();
    await screen.findByRole("button", { name: /药品安全性分析/ });
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索工具" }), "循证传播");
    expect(await screen.findByRole("button", { name: /公共数据差异分析/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /药品安全性分析/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/循证传播/)).not.toBeInTheDocument();
  });

  it("finds a tool by 虚拟临研, the old name of 虚拟临床研究, and never prints the old name", async () => {
    mocks.listWebResearchAgents.mockResolvedValue([
      ...agents,
      { ...agents[0], id: "custom-sim-tool", title: "样本量估算", category: "临床证据", description: "在虚拟临床研究里估算样本量和功效。", starterPrompts: ["估算一个两组试验的样本量。"] },
    ]);
    renderPage();
    await screen.findByRole("button", { name: /药品安全性分析/ });
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索工具" }), "虚拟临研");
    expect(await screen.findByRole("button", { name: /样本量估算/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /药品安全性分析/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/虚拟临研/)).not.toBeInTheDocument();
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
    await userEvent.click(await screen.findByRole("button", { name: "药品安全性分析" }));
    // Bound before the conversation exists, so the router honours the choice
    // rather than re-deciding it.
    await waitFor(() => expect(mocks.putWebResearchSession).toHaveBeenCalledWith(
      expect.stringMatching(/^web-/), { mode: "specialist", agentId: "adr-analysis", agentVersion: "1.0.0" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/chat"));
    expect(screen.getByTestId("capability")).toHaveTextContent("adr-analysis");
    const intent = JSON.parse(screen.getByTestId("intent").textContent!);
    expect(intent.kind).toBe("create");
    expect(intent.sessionId).toMatch(/^web-/);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  // The 「循证 GEO」 capabilities stay public — their module binds a
  // conversation to one by id, and an internal one would answer 403 — and are
  // not tools to pick here (build spec 2026-09-25 §6, `display.listed: false`).
  it("leaves out a capability its own module opens, while the catalogue still carries it", async () => {
    const geo = ["geo-insight", "geo-strategy", "geo-content", "geo-proposal"].map((id) => ({ ...agents[3], id, skill: id, runtimeAgent: `evimed-${id}` }));
    for (const entry of geo) expect(CAPABILITY_DISPLAY[entry.id]?.listed, entry.id).toBe(false);
    mocks.listWebResearchAgents.mockResolvedValue([...agents, ...geo]);
    renderPage();
    await screen.findByRole("button", { name: /药品安全性分析/ });
    expect(tool("论文审稿")).toBeInTheDocument();
    for (const entry of geo) {
      expect(screen.queryByRole("button", { name: CAPABILITY_DISPLAY[entry.id].title })).not.toBeInTheDocument();
    }
    expect(screen.queryByText(/循证 GEO/)).not.toBeInTheDocument();
  });

  // What a row says about a tool's state is a reason the reader can act on, as a word beside it, and only that (2026-10-14): a
  // deployment's last failed run, a retry budget, an engine that is down, nothing proven here — none of it is the reader's to
  // mend, and every account opens this page. Nothing is hidden or disabled for what its state says.
  describe("availability", () => {
    const availability = (id: string, state: string, label: string, text: string, code: string, detail?: string) => ({
      kind: "capability" as const, id, version: "1.0.0", state: state as never, label, text, reason: { code, ...(detail ? { detail } : {}), source: "operation-record" },
    });
    /** One tool for each way a deployment says something about it. */
    const labelled = () => [
      { ...agents[0], availability: availability("adr-analysis", "executable", "可运行", "1.0.0 版已在这个部署上成功运行过，最近一次是 2026-10-03。", "succeeded-here") },
      { ...agents[1], availability: availability("off-label-analysis", "limited", "受限", "分析引擎（一项工具）现在连不上；提交后仍会受理，受阻时会如实说明。", "engine-not-ready", "meta_analysis") },
      // The owner's own card (2026-10-14): the last run of the tool failed, on this deployment, for somebody.
      { ...agents[2], availability: availability("meta-analysis", "limited", "受限",
        "最近一次运行没有成功（这项能力约定必须产出的文件里，有一个没有写出来，因此这份成果不完整、没有通过质量门。已经写好的部分仍在工作区里。）；此前成功过，最近一次是 2026-10-04。",
        "last-operation-failed", "specialist_required_output_missing") },
      { ...agents[3], availability: availability("peer-review", "unverified", "未验证", "当前是模拟运行环境，不能证明真实可运行。", "mock-runtime") },
    ];

    it("draws nothing for a deployment's own reasons — a failed last run, an engine, nothing proven — to the eye or to assistive technology", async () => {
      mocks.listWebResearchAgents.mockResolvedValue(labelled());
      renderPage();
      await screen.findByRole("button", { name: /药品安全性分析/ });
      for (const name of ["药品安全性分析", "超说明书用药分析", "自动化 Meta 分析", "论文审稿"]) {
        expect(tool(name)).not.toHaveAttribute("aria-describedby");
        expect(card(name).querySelector("[data-tag]")).toBeNull();
      }
      expect(screen.queryByText(/^(可运行|已安装|未验证|受限|不可用|规划中)$/)).not.toBeInTheDocument();
      expect(document.querySelectorAll(".sr-only")).toHaveLength(0);
      // The sentence of a run, with its gate and its workspace, is nowhere on the page.
      expect(document.body.textContent).not.toMatch(/质量门|能力约定|工作区|现在连不上|成功运行过|不能证明真实可运行/);
    });

    it("a deployment whose last Meta run failed stamps no limited tag on any card", async () => {
      mocks.listWebResearchAgents.mockResolvedValue(labelled());
      renderPage();
      await screen.findByRole("button", { name: /药品安全性分析/ });
      expect(document.querySelector("[data-tag]")).toBeNull();
      expect(card("自动化 Meta 分析")).toHaveTextContent(CAPABILITY_DISPLAY["meta-analysis"].description);
      expect(card("自动化 Meta 分析")).not.toHaveTextContent(/受限|没有成功/);
    });

    it("says what the reader can mend — a connector they have not given a key for — as a word, its sentence and the way to add it", async () => {
      mocks.listWebResearchAgents.mockResolvedValue([
        { ...agents[0], availability: availability("adr-analysis", "limited", "受限", "用到「OpenGWAS」的数据时需要添加你自己的凭据；可以先开始，缺的部分之后在对话里补上。", "data-source-not-configured", "opengwas") },
        agents[1],
      ]);
      render(
        <MemoryRouter>
          <CapabilitiesPage />
        </MemoryRouter>,
      );
      await screen.findByRole("button", { name: /药品安全性分析/ });
      const row = card("药品安全性分析");
      expect(within(row).getByText("受限")).toBeInTheDocument();
      expect(row).toHaveTextContent("用到「OpenGWAS」的数据时需要添加你自己的凭据");
      // The sentence carries its action: the page where a key is given.
      expect(within(row).getByRole("link", { name: "去添加" })).toHaveAttribute("href", "/app/account?tab=connectors");
      expect(within(card("超说明书用药分析")).queryByRole("link")).toBeNull();
    });

    it("tells a module the account is not offered with one plain word and no sentence", async () => {
      mocks.listWebResearchAgents.mockResolvedValue([
        { ...agents[0], availability: availability("adr-analysis", "unavailable", "不可用", "对应的功能模块还没有向你的账号开放。", "module-not-open") },
      ]);
      renderPage();
      await screen.findByRole("button", { name: /药品安全性分析/ });
      const row = card("药品安全性分析");
      expect(within(row).getByText("暂未开放")).toBeInTheDocument();
      expect(row).not.toHaveTextContent("功能模块");
    });

    it("never hides a tool or disables its row for what its label says", async () => {
      mocks.listWebResearchAgents.mockResolvedValue(labelled());
      render(
        <MemoryRouter initialEntries={["/app/capabilities"]}>
          <Routes>
            <Route path="/app/capabilities" element={<CapabilitiesPage />} />
            <Route path="/app/chat" element={<LocationProbe />} />
          </Routes>
        </MemoryRouter>,
      );
      await screen.findByRole("button", { name: /药品安全性分析/ });
      expect(screen.getAllByRole("listitem").filter((item) => item.querySelector("button"))).toHaveLength(4);
      expect(tool("自动化 Meta 分析")).toBeEnabled();
      await userEvent.click(tool("自动化 Meta 分析"));
      await waitFor(() => expect(mocks.putWebResearchSession).toHaveBeenCalledWith(
        expect.stringMatching(/^web-/), { mode: "specialist", agentId: "meta-analysis", agentVersion: "1.0.0" }));
      await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/chat"));
    });

    it("draws nothing extra for a catalogue that carries no label, or one that could not compute it", async () => {
      mocks.listWebResearchAgents.mockResolvedValue([agents[0], { ...agents[1], availability: null }]);
      renderPage();
      await screen.findByRole("button", { name: /药品安全性分析/ });
      for (const name of ["药品安全性分析", "超说明书用药分析"]) {
        expect(tool(name)).not.toHaveAttribute("aria-describedby");
        expect(card(name)).not.toHaveTextContent(/可运行|受限|不可用|未验证|已安装|规划中/);
      }
    });
  });

  it("offers a retry when the catalogue could not be loaded, rather than a dead error line", async () => {
    mocks.listWebResearchAgents.mockRejectedValueOnce(new WebApiError("later", { status: 503, code: "service_unavailable" }));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("无法加载工具目录");
    mocks.listWebResearchAgents.mockResolvedValueOnce(agents);
    await userEvent.click(screen.getByRole("button", { name: /重试/ }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /药品安全性分析/ })).toBeInTheDocument();
  });

  // A card is a third of the 960 px column: about 280 px of text, twenty
  // characters of 14 px Chinese a line. The sentence is written to fit two
  // lines where it is defined (the capability's `display:` block), because a
  // card that clips it with 「…」 shows half a sentence (plan §5.4).
  it("every tool's sentence is one complete sentence short enough for its row", () => {
    const entries = Object.entries(CAPABILITY_DISPLAY);
    expect(entries.length).toBeGreaterThanOrEqual(15);
    for (const [id, entry] of entries) {
      const text = entry.description;
      const width = [...text].reduce((sum, char) => sum + ((char.codePointAt(0) ?? 0) > 0x2e80 ? 1 : 0.55), 0);
      expect(width, `${id}: ${text}`).toBeLessThanOrEqual(40);
      expect(text.match(/。/g) ?? [], `${id}: ${text}`).toHaveLength(1);
      expect(text.endsWith("。"), `${id}: ${text}`).toBe(true);
      expect(text, id).not.toMatch(/…|\.\.\./);
    }
  });

  /** The catalogue has loaded and whatever the page asked for has been answered. */
  const settled = async () => {
    await screen.findByRole("button", { name: /药品安全性分析/ });
    await act(async () => {});
  };
  const title = (id: string) => CAPABILITY_DISPLAY[id].title;
  const LISTED = ["adr-analysis", "off-label-analysis", "meta-analysis", "peer-review"];

  describe("what a tool usually takes out of a simulated allowance", () => {
    beforeEach(() => { mocks.allowance.mockResolvedValue(simulatedWallet); });

    // The 「模拟」 mark is no longer drawn beside each price (2026-10-14): the allowance's own page says once, at the top, that
    // its amounts are simulated, and a row is a tool and its price.
    it("is said beside how long the tool takes, from one read for every listed tool, with no mark of its own", async () => {
      // A capability its own module opens is not listed, so it is not asked about either.
      mocks.listWebResearchAgents.mockResolvedValue([...agents, { ...agents[3], id: "geo-insight", skill: "geo-insight", runtimeAgent: "evimed-geo-insight" }]);
      renderPage();
      await waitFor(() => expect(card("药品安全性分析")).toHaveTextContent("约 20～40 分钟 · 约 4～8 灵豆"));
      expect(within(card("药品安全性分析")).queryByText(SIMULATED_WALLET_LABEL)).not.toBeInTheDocument();
      // One figure where the two ends meet, still after the duration.
      expect(card(title("off-label-analysis"))).toHaveTextContent(/分钟 · 约 3 灵豆/);
      expect(within(card(title("off-label-analysis"))).queryByText(SIMULATED_WALLET_LABEL)).not.toBeInTheDocument();
      expect(screen.queryByText(SIMULATED_WALLET_LABEL)).not.toBeInTheDocument();
      expect(mocks.estimates).toHaveBeenCalledTimes(1);
      expect(mocks.estimates).toHaveBeenCalledWith(LISTED);
    });

    it("rounds the estimate to whole credits, the low end down and the high end up, so a figure never wraps the row", async () => {
      mocks.estimates.mockResolvedValue({
        ...estimates,
        items: [estimate("adr-analysis", 4.05, 7.02), estimate("off-label-analysis", 0.2, 0.6), estimate("peer-review", 2.4, 2.6)],
      });
      renderPage();
      await waitFor(() => expect(card("药品安全性分析")).toHaveTextContent("约 20～40 分钟 · 约 4～8 灵豆"));
      // Under one credit the cents are the figure.
      expect(card(title("off-label-analysis"))).toHaveTextContent("约 0.2～0.6 灵豆");
      // Two ends that round to different whole credits stay a range.
      expect(card(title("peer-review"))).toHaveTextContent("约 2～3 灵豆");
    });

    it("is left out for a tool nothing supports an estimate of, which gets no zero", async () => {
      renderPage();
      await waitFor(() => expect(card("药品安全性分析")).toHaveTextContent("灵豆"));
      // `basis: "none"`, and a tool the answer does not carry at all.
      for (const id of ["meta-analysis", "peer-review"]) {
        const tool = card(title(id));
        expect(tool).toHaveTextContent(/约 \d+～\d+ 分钟/);
        expect(tool).not.toHaveTextContent(/灵豆/);
        expect(within(tool).queryByText(SIMULATED_WALLET_LABEL)).not.toBeInTheDocument();
      }
    });

    it.each([
      ["names no range", estimate("adr-analysis", null, null)],
      ["names half a range", estimate("adr-analysis", 4, null)],
      ["names a range the wrong way round", estimate("adr-analysis", 8, 4)],
      ["names a range below nothing", estimate("adr-analysis", -2, 8)],
      ["says nothing supports it, whatever numbers it carries", estimate("adr-analysis", 4, 8, "none")],
    ])("is left out when the estimate %s", async (_, item) => {
      mocks.estimates.mockResolvedValue({ ...estimates, items: [item, estimate("peer-review", 1, 2)] });
      renderPage();
      // The read was answered and drawn: the other tool has its price.
      await waitFor(() => expect(card(title("peer-review"))).toHaveTextContent("约 1～2 灵豆"));
      expect(card("药品安全性分析")).toHaveTextContent("约 20～40 分钟");
      expect(card("药品安全性分析")).not.toHaveTextContent(/灵豆/);
      expect(within(card("药品安全性分析")).queryByText(SIMULATED_WALLET_LABEL)).not.toBeInTheDocument();
    });

    it("is not asked for again by a search or a category, which filter what is already here", async () => {
      renderPage();
      await waitFor(() => expect(card("药品安全性分析")).toHaveTextContent("约 4～8 灵豆"));
      await userEvent.type(screen.getByRole("searchbox", { name: "搜索工具" }), "氨甲环酸");
      expect(screen.queryByRole("button", { name: /药品安全性分析/ })).not.toBeInTheDocument();
      await userEvent.clear(screen.getByRole("searchbox", { name: "搜索工具" }));
      await userEvent.click(within(screen.getByRole("group", { name: "分类" })).getByRole("button", { name: "药学评价" }));
      // The row comes back with the price it had.
      expect(card("药品安全性分析")).toHaveTextContent("约 20～40 分钟 · 约 4～8 灵豆");
      await act(async () => {});
      expect(mocks.estimates).toHaveBeenCalledTimes(1);
    });

    it("costs the page nothing when it cannot be read: the rows stay as they are, with no error", async () => {
      mocks.estimates.mockRejectedValue(new WebApiError("later", { status: 503, code: "evimed_credits_unreachable" }));
      renderPage();
      await settled();
      expect(mocks.estimates).toHaveBeenCalledTimes(1);
      for (const id of LISTED) {
        expect(card(title(id))).toHaveTextContent(/约 \d+～\d+ 分钟/);
        expect(card(title(id))).not.toHaveTextContent(/灵豆/);
      }
      expect(card("药品安全性分析")).toHaveTextContent(CAPABILITY_DISPLAY["adr-analysis"].description);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByText(SIMULATED_WALLET_LABEL)).not.toBeInTheDocument();
      // Not asked for again and again either.
      await act(async () => {});
      expect(mocks.estimates).toHaveBeenCalledTimes(1);
    });

    it("still opens a conversation with the tool from a row that carries a price", async () => {
      render(
        <MemoryRouter initialEntries={["/app/capabilities"]}>
          <Routes>
            <Route path="/app/capabilities" element={<CapabilitiesPage />} />
            <Route path="/app/chat" element={<LocationProbe />} />
          </Routes>
        </MemoryRouter>,
      );
      await waitFor(() => expect(card("药品安全性分析")).toHaveTextContent("约 4～8 灵豆"));
      await userEvent.click(tool("药品安全性分析"));
      await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/chat"));
      expect(screen.getByTestId("capability")).toHaveTextContent("adr-analysis");
    });
  });

  describe("on a deployment whose allowance is not simulated", () => {
    it.each([
      ["does not bill research", billingOff],
      ["bills research from a real wallet", realWallet],
      ["bills research and says nothing about a simulated wallet", olderWallet],
    ])("asks for no estimate and draws no price, mark or prompt where it %s", async (_, answer) => {
      mocks.allowance.mockResolvedValue(answer);
      renderPage();
      await settled();
      // The rows are there, as they always were…
      expect(card("药品安全性分析")).toHaveTextContent("约 20～40 分钟");
      for (const id of LISTED) expect(card(title(id))).not.toHaveTextContent(/灵豆/);
      // …and nothing of the simulated allowance is.
      expect(mocks.estimates).not.toHaveBeenCalled();
      expect(screen.queryAllByText(/模拟/)).toEqual([]);
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(mocks.allowance).toHaveBeenCalledTimes(1);
    });

    it("shows the catalogue all the same when the allowance cannot be read, and asks for no estimate", async () => {
      mocks.allowance.mockRejectedValue(new Error("network"));
      renderPage();
      await settled();
      expect(card("药品安全性分析")).toHaveTextContent("约 20～40 分钟");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(mocks.estimates).not.toHaveBeenCalled();
    });
  });

  describe("the low-allowance prompt", () => {
    it("is at the top of the page when the simulated allowance is running low, with the way to the simulated recharge page", async () => {
      mocks.allowance.mockResolvedValue({ ...simulatedWallet, available: 5 });
      renderPage();
      const prompt = await screen.findByRole("status");
      expect(prompt).toHaveTextContent("额度即将用完，还剩 5.00 灵豆。");
      expect(within(prompt).getByText(SIMULATED_WALLET_LABEL)).toBeInTheDocument();
      expect(within(prompt).getByRole("link", { name: "去模拟充值" })).toHaveAttribute("href", SIMULATED_WALLET_PAGES.recharge);
      await settled();
      // Under the one toolbar and above the tools: the first thing the list says is whether there is allowance to start one.
      const toolbar = screen.getByRole("group", { name: "科研工具筛选" });
      expect(toolbar.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(prompt.compareDocumentPosition(card("药品安全性分析")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("says an empty allowance is used up", async () => {
      mocks.allowance.mockResolvedValue({ ...simulatedWallet, available: 0 });
      renderPage();
      expect(await screen.findByRole("status")).toHaveTextContent("额度已用完，模拟充值后可以继续使用。");
      await settled();
    });

    it("is not shown while the allowance is above the threshold the server names", async () => {
      mocks.allowance.mockResolvedValue(simulatedWallet);
      renderPage();
      // The allowance was read and is a simulated one: the rows carry prices.
      await waitFor(() => expect(card("药品安全性分析")).toHaveTextContent("约 4～8 灵豆"));
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    // The balance moves, so the page reads it again on opening and draws only
    // the one it just read — never the one another surface left behind.
    it("is drawn from the balance just read, not from the one held", async () => {
      mocks.allowance.mockResolvedValue({ ...simulatedWallet, available: 5 });
      const first = renderPage();
      expect(await screen.findByRole("status")).toHaveTextContent("还剩 5.00 灵豆");
      first.unmount();

      let answer!: (value: object) => void;
      mocks.allowance.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
      renderPage();
      await settled();
      expect(mocks.allowance).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      // A top-up happened in between: nothing is prompted.
      await act(async () => { answer({ ...simulatedWallet, available: 105 }); });
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(card("药品安全性分析")).toHaveTextContent("约 4～8 灵豆");
    });

    it("is not drawn from the balance held when the read that would replace it fails", async () => {
      mocks.allowance.mockResolvedValueOnce({ ...simulatedWallet, available: 5 });
      const first = renderPage();
      expect(await screen.findByRole("status")).toBeInTheDocument();
      first.unmount();
      mocks.allowance.mockRejectedValue(new Error("network"));
      renderPage();
      await settled();
      expect(mocks.allowance).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      // The deployment is still the one that said its wallet is simulated: the prices stay.
      expect(card("药品安全性分析")).toHaveTextContent("约 4～8 灵豆");
    });
  });
});
