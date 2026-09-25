import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CAPABILITY_DISPLAY } from "@evimed/domain";
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


const mocks = vi.hoisted(() => ({
  listWebResearchAgents: vi.fn(),
  listWebResearchSessions: vi.fn(),
  putWebResearchSession: vi.fn(),
}));

// The error dictionary (`webErrorMessage`) lives in this module and the code
// under test calls it, so the real exports come through and only the calls
// this test drives are replaced.
vi.mock("@/lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  listWebResearchAgents: mocks.listWebResearchAgents,
  listWebResearchSessions: mocks.listWebResearchSessions,
  putWebResearchSession: mocks.putWebResearchSession,
  getWebProjectId: () => "default",
}));

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

/** A card, by the tool it opens. */
const card = (title: string) => screen.getByRole("button", { name: `用「${title}」开始一次对话` });

describe("CapabilitiesPage", () => {
  beforeEach(() => {
    mocks.listWebResearchAgents.mockReset();
    mocks.listWebResearchAgents.mockResolvedValue(agents);
    mocks.listWebResearchSessions.mockReset();
    mocks.listWebResearchSessions.mockResolvedValue([]);
    mocks.putWebResearchSession.mockReset();
    mocks.putWebResearchSession.mockImplementation(async (sessionId: string, selection: object) => ({ sessionId, ...selection }));
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

  it("shows the grid's shape while the catalogue loads", () => {
    mocks.listWebResearchAgents.mockReturnValue(new Promise(() => {}));
    const { container } = renderPage();
    expect(container.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  // 2026-09-23 plan §5.4: the header is the title and a search box; the
  // sentence under the title explained how the page worked, and was wrong.
  it("has a title and a search box in its header, and no sentence under the title", async () => {
    renderPage();
    const heading = await screen.findByRole("heading", { level: 1, name: "科研工具" });
    expect(screen.getByRole("searchbox", { name: "搜索工具" })).toHaveAttribute("placeholder", "搜索工具");
    expect(heading.closest("header")?.querySelectorAll("p")).toHaveLength(0);
    expect(screen.queryByText(/选一项工具/)).not.toBeInTheDocument();
  });

  it("groups the tools in the product's order, each card one sentence and how long it usually takes", async () => {
    renderPage();
    await screen.findByRole("button", { name: /药品安全性分析/ });
    // Evidence before pharmacy before writing, not the sort order of the names;
    // and no 「N 项」 after a group's name.
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["临床证据", "药学评价", "写作与传播"]);
    const pharmacy = screen.getByRole("heading", { level: 2, name: "药学评价" }).closest("section")!;
    const safety = within(pharmacy).getByRole("button", { name: "用「药品安全性分析」开始一次对话" });
    // The whole sentence, never cut to 「…」 by the card.
    expect(safety).toHaveTextContent(CAPABILITY_DISPLAY["adr-analysis"].description);
    expect(safety).toHaveTextContent("约 20–40 分钟");
    expect(safety.innerHTML).not.toMatch(/truncate|line-clamp/);
    // What a tool needs from the researcher is the composer's to say, not the card's.
    expect(card("论文审稿")).not.toHaveTextContent("需要你的资料");
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

    await userEvent.clear(screen.getByRole("searchbox", { name: "搜索工具" }));
    const filters = screen.getByRole("group", { name: "分类" });
    expect(within(filters).getAllByRole("button").map((chip) => chip.textContent)).toEqual(["全部", "临床证据", "药学评价", "写作与传播"]);
    await userEvent.click(within(filters).getByRole("button", { name: "药学评价" }));
    expect(within(filters).getByRole("button", { name: "药学评价" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /药品安全性分析/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /自动化 Meta 分析/ })).not.toBeInTheDocument();
  });

  // The drawer with its own question box is gone: a card opens the conversation
  // the reader was going to type in anyway, with that tool on.
  it("a card opens a new conversation carrying the tool, and asks nothing here", async () => {
    render(
      <MemoryRouter initialEntries={["/app/capabilities"]}>
        <Routes>
          <Route path="/app/capabilities" element={<CapabilitiesPage />} />
          <Route path="/app/chat" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "用「药品安全性分析」开始一次对话" }));
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
    expect(card("论文审稿")).toBeInTheDocument();
    for (const entry of geo) {
      expect(screen.queryByRole("button", { name: `用「${CAPABILITY_DISPLAY[entry.id].title}」开始一次对话` })).not.toBeInTheDocument();
    }
    expect(screen.queryByText(/循证 GEO/)).not.toBeInTheDocument();
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
  it("every tool's sentence is one sentence that fits two lines of its card", () => {
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
});
