import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { GEO_PROJECT } from "@/components/geo/__fixtures__/geoProjects";
import { diagnosisFilled, diagnosisWith, monitoringFilled } from "@/components/geo/__fixtures__/geoTabs";
import { GEO_OFF_SENTENCE } from "@/components/geo/GeoStates";
import { GEO_TABS } from "@/components/geo/geoTabs";
import { expectComposed } from "@/test/expectComposed";
import { GeoProjectLayout } from "./GeoProjectPage";

const client = vi.hoisted(() => ({
  useGeoFeature: vi.fn(),
  getGeoProject: vi.fn(),
  getGeoDiagnosis: vi.fn(),
  getGeoMonitoring: vi.fn(),
  getGeoStrategy: vi.fn(),
  getGeoDistribution: vi.fn(),
  runGeoStep: vi.fn(),
  exportGeo: vi.fn(),
  patchGeoProject: vi.fn(),
  deleteGeoProject: vi.fn(),
  open: vi.fn(),
}));

vi.mock("@/lib/geoClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/geoClient")>()),
  useGeoFeature: client.useGeoFeature,
  getGeoProject: client.getGeoProject,
  getGeoDiagnosis: client.getGeoDiagnosis,
  getGeoMonitoring: client.getGeoMonitoring,
  getGeoStrategy: client.getGeoStrategy,
  getGeoDistribution: client.getGeoDistribution,
  runGeoStep: client.runGeoStep,
  exportGeo: client.exportGeo,
  patchGeoProject: client.patchGeoProject,
  deleteGeoProject: client.deleteGeoProject,
}));

vi.mock("@/components/geo/useOpenGeoConversation", () => ({ useOpenGeoConversation: () => client.open }));

// The tabs other than 总览 have their own tests; here each is a marker that says the layout gave it the project — and, through the
// toolbar hook, one filter, so what the band does with a tab's controls can be read.
const marker = vi.hoisted(() => (name: string, useGeoToolbar: (toolbar: unknown) => void) => ({ geoId, project }: { geoId: string; project: { name: string } }) => {
  useGeoToolbar({ filters: [{ kind: "chips", label: `${name} 的筛选`, options: [{ value: "a", label: "甲" }, { value: "b", label: "乙" }], value: "a", onChange: () => undefined }] });
  return <div data-testid={`${name}-tab`}>{geoId}:{project.name}</div>;
});
const toolbarHook = vi.hoisted(() => async () => (await import("@/components/geo/geoFrame")).useGeoToolbar as (toolbar: unknown) => void);
vi.mock("@/components/geo/tabs/VisibilityTab", async () => ({ VisibilityTab: marker("visibility", await toolbarHook()) }));
vi.mock("@/components/geo/tabs/AccuracyTab", async () => ({ AccuracyTab: marker("accuracy", await toolbarHook()) }));
vi.mock("@/components/geo/tabs/QuestionsTab", async () => ({ QuestionsTab: marker("questions", await toolbarHook()) }));
vi.mock("@/components/geo/tabs/SourcesTab", async () => ({ SourcesTab: marker("sources", await toolbarHook()) }));
vi.mock("@/components/geo/tabs/ActionsTab", async () => ({ ActionsTab: marker("actions", await toolbarHook()) }));
vi.mock("@/components/geo/tabs/PlanTab", async () => ({ PlanTab: marker("plan", await toolbarHook()) }));
vi.mock("@/components/geo/tabs/EvidenceTab", async () => ({ EvidenceTab: marker("evidence", await toolbarHook()), readableSourceRef: () => null }));

function Landed() {
  const location = useLocation();
  return <p data-testid="landed">{`${location.pathname}${location.search}${location.hash}`}</p>;
}

/** The project the way the app mounts it: one layout over the tab routes and the answer. */
function Routed() {
  return (
    <Routes>
      <Route path="/app/geo/:geoId" element={<><GeoProjectLayout /><Landed /></>}>
        <Route index element={null} />
        <Route path="answers/:snapshotId" element={<div data-testid="answer-page">一条回答</div>} />
        <Route path=":tab" element={null} />
      </Route>
      <Route path="/app/geo" element={<Landed />} />
    </Routes>
  );
}

function renderProject(path = "/app/geo/geo_masi") {
  return render(<MemoryRouter initialEntries={[path]}><Routed /></MemoryRouter>);
}

/** The measured round, with one statement severe enough to reach a patient. */
const severeDiagnosis = diagnosisWith([
  { ...diagnosisFilled.errors[0], id: "err_s3", severity: "S3" as const, statement: "甲状腺结节患者禁用信尔美", status: "open" as const },
  diagnosisFilled.errors[0],
]);

beforeEach(() => {
  vi.clearAllMocks();
  client.useGeoFeature.mockReturnValue("on");
  client.getGeoProject.mockResolvedValue(GEO_PROJECT);
  client.getGeoDiagnosis.mockResolvedValue(severeDiagnosis);
  client.getGeoMonitoring.mockResolvedValue(monitoringFilled);
  client.getGeoStrategy.mockRejectedValue(new Error("no plan in this test"));
  client.getGeoDistribution.mockResolvedValue({ budget: null, spentCny: 0, reservedCny: 0, suggestedBudgetCny: 5000, market: { configured: true }, orders: [], ownedLinks: [] });
  client.open.mockResolvedValue(true);
  client.patchGeoProject.mockResolvedValue({});
  client.deleteGeoProject.mockResolvedValue({});
});

/** The tab list of the band, by the open tab's name. */
const tabsOf = () => within(screen.getByRole("tablist", { name: "项目视图" }));
const band = () => document.querySelector("[data-page-chrome]") as HTMLElement;
const railSteps = () => [...document.querySelectorAll("[data-step-rail] [data-rail-step]")].map((step) => step.getAttribute("data-rail-step"));

describe("a GEO project's page", () => {
  it("is one header line, then one band: the eight steps, eight tabs by question", async () => {
    renderProject();
    expect(await screen.findByRole("heading", { level: 1, name: "玛仕度肽注射液" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "周报" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "对话" })).toBeInTheDocument();
    // The header's 「⋯」 is the header's 36 px icon button, not a row's 28.
    expect(screen.getByRole("button", { name: "更多操作" })).toHaveClass("h-control", "w-9");

    expect(tabsOf().getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["总览", "可见度", "准确与安全", "问题与回答", "信源", "行动", "方案", "依据"]);
    expect(screen.getByRole("tab", { name: "总览" })).toHaveAttribute("aria-selected", "true");

    expect(railSteps()).toEqual(["evidence", "journey", "questions", "diagnosis", "sources", "content", "distribution", "monitoring"]);
    const states = [...document.querySelectorAll("[data-step-rail] [data-rail-step]")].map((step) => step.getAttribute("data-rail-state"));
    expect(states).toEqual(["done", "done", "done", "done", "done", "active", "active", "active"]);
    // The rail is the only progress there is: no second bar underneath it.
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  // R19 (audit C A.1; the reverse of R11's "rail on 总览 only"): the band is the layout's, so it is the same on every tab — present,
  // fixed, eight steps, the rail before the tabs and the tabs before the body.
  it("has the band on every tab, fixed at the top, with the same eight steps and the same rows", async () => {
    renderProject();
    await screen.findByRole("tablist", { name: "项目视图" });
    const rows: number[] = [];
    for (const tab of GEO_TABS) {
      await userEvent.click(tabsOf().getByRole("tab", { name: tab.label }));
      await waitFor(() => expect(tabsOf().getByRole("tab", { name: tab.label })).toHaveAttribute("aria-selected", "true"));
      expect(railSteps(), tab.label).toHaveLength(8);
      expect(band(), tab.label).toHaveClass("sticky", "top-0");
      // The rail, the tabs and the toolbar's row (drawn or reserved): the same three, in that order.
      expect(band().children.length, tab.label).toBe(3);
      const [rail, tabList, toolbar] = [...band().children];
      expect(rail).toHaveAttribute("data-step-rail");
      expect(tabList.querySelector("[role=tablist]") ?? tabList).toBeTruthy();
      expect(toolbar).toBeTruthy();
      rows.push(band().children.length);
      const facts = expectComposed(document.body, { stepRail: true, tablists: 1 });
      expect(facts.stepRails, tab.label).toHaveLength(1);
    }
    expect(new Set(rows)).toEqual(new Set([3]));
  });

  it("keeps the band on the answer page, with 问题与回答 selected", async () => {
    renderProject("/app/geo/geo_masi/answers/snap_1");
    expect(await screen.findByTestId("answer-page")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "问题与回答" })).toHaveAttribute("aria-selected", "true");
    expect(railSteps()).toHaveLength(8);
    expect(band()).toHaveClass("sticky");
    // The answer is in the band's body: the tab panel the open tab names.
    expect(document.getElementById("geo-tab-panel")).toContainElement(screen.getByTestId("answer-page"));
    expect(document.title).toBe("玛仕度肽注射液 · AI 回答监测 · EviMed");
  });

  it("underlines the steps the open tab is made of, and moves the underline with the tab", async () => {
    renderProject();
    await screen.findByRole("tablist", { name: "项目视图" });
    const current = () => [...document.querySelectorAll("[data-step-rail] [aria-current='step']")].map((node) => node.closest("[data-rail-step]")?.getAttribute("data-rail-step"));
    // 总览 is the summary of all of them and belongs to none.
    expect(current()).toEqual([]);
    await userEvent.click(tabsOf().getByRole("tab", { name: "行动" }));
    await waitFor(() => expect(current()).toEqual(["content", "distribution", "monitoring"]));
    await userEvent.click(tabsOf().getByRole("tab", { name: "准确与安全" }));
    await waitFor(() => expect(current()).toEqual(["diagnosis"]));
    await userEvent.click(tabsOf().getByRole("tab", { name: "依据" }));
    await waitFor(() => expect(current()).toEqual(["evidence"]));
  });

  it("takes a step to where its result is read: the tab, the view, the block", async () => {
    renderProject();
    await screen.findByRole("tablist", { name: "项目视图" });
    const rail = document.querySelector("[data-step-rail]") as HTMLElement;
    const hrefOf = (step: string) => rail.querySelector(`[data-rail-step='${step}'] a`)?.getAttribute("href");
    expect(hrefOf("evidence")).toBe("/app/geo/geo_masi/evidence");
    expect(hrefOf("journey")).toBe("/app/geo/geo_masi/questions?view=journey");
    expect(hrefOf("questions")).toBe("/app/geo/geo_masi/questions");
    expect(hrefOf("diagnosis")).toBe("/app/geo/geo_masi/accuracy#geo-errors");
    expect(hrefOf("sources")).toBe("/app/geo/geo_masi/sources");
    expect(hrefOf("content")).toBe("/app/geo/geo_masi/actions");
    expect(hrefOf("monitoring")).toBe("/app/geo/geo_masi/visibility#geo-trend");
    // A click goes there, and the tab that holds it opens.
    await userEvent.click(within(rail).getByRole("link", { name: /诊断/ }));
    expect(await screen.findByTestId("accuracy-tab")).toBeInTheDocument();
    expect(screen.getByTestId("landed")).toHaveTextContent("/app/geo/geo_masi/accuracy#geo-errors");
  });

  it("draws the tab's controls in the band, above the body, and takes them away with the tab", async () => {
    renderProject("/app/geo/geo_masi/sources");
    const body = document.querySelector("[data-page-body]") as HTMLElement;
    const group = await screen.findByRole("group", { name: "sources 的筛选" });
    expect(band()).toContainElement(group);
    expect(body).not.toContainElement(group);
    // Before the body in the document, and the same one toolbar on the next tab.
    expect(group.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(tabsOf().getByRole("tab", { name: "方案" }));
    expect(await screen.findByRole("group", { name: "plan 的筛选" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "sources 的筛选" })).not.toBeInTheDocument();
    expect(document.querySelectorAll("[data-toolbar]")).toHaveLength(1);
    // 总览 has no controls: the row is reserved and empty, so the band does not change height.
    await userEvent.click(tabsOf().getByRole("tab", { name: "总览" }));
    await waitFor(() => expect(document.querySelectorAll("[data-toolbar]")).toHaveLength(0));
    expect(band().lastElementChild).toHaveClass("min-h-11");
  });

  it("ends the toolbar with one text button that continues the tab's step, and only on the tabs that have one", async () => {
    renderProject("/app/geo/geo_masi/evidence");
    await screen.findByTestId("evidence-tab");
    const toolbar = () => document.querySelector("[data-toolbar]") as HTMLElement;
    // The chips of the marker's own filter are pressed-or-not buttons; the text button that continues the step is the one that is not.
    const buttons = () => [...toolbar().querySelectorAll("button:not([aria-pressed])")].map((button) => button.textContent);
    await waitFor(() => expect(buttons()).toContain("让 AI 补充结论"));
    // It asks in the project's conversation, with the brief waiting unsent.
    await userEvent.click(within(toolbar()).getByRole("button", { name: "让 AI 补充结论" }));
    expect(client.open).toHaveBeenCalledWith({ projectId: "p-masi", sessionId: "ses_geo_masi" }, expect.stringContaining("补充信尔美还没有覆盖的说明书内容"));

    await userEvent.click(tabsOf().getByRole("tab", { name: "信源" }));
    await waitFor(() => expect(buttons()).toEqual(["选目标档"]));
    await userEvent.click(within(toolbar()).getByRole("button", { name: "选目标档" }));
    expect(screen.getByTestId("landed")).toHaveTextContent("/app/geo/geo_masi/plan#geo-targets");

    // 准确与安全 and 可见度 are measured by the schedule: no button.
    await userEvent.click(tabsOf().getByRole("tab", { name: "准确与安全" }));
    await waitFor(() => expect(buttons()).toEqual([]));
    await userEvent.click(tabsOf().getByRole("tab", { name: "可见度" }));
    await waitFor(() => expect(buttons()).toEqual([]));

    await userEvent.click(tabsOf().getByRole("tab", { name: "行动" }));
    await waitFor(() => expect(buttons()).toEqual(["让 AI 写下一批"]));
  });

  it("offers 设预算 instead on 行动 where a market is connected and nobody has set one, and opens the dialog with the tier's suggestion", async () => {
    client.getGeoProject.mockResolvedValue({ ...GEO_PROJECT, budget: null });
    renderProject("/app/geo/geo_masi/actions");
    const toolbar = () => document.querySelector("[data-toolbar]") as HTMLElement;
    await userEvent.click(await waitFor(() => within(toolbar()).getByRole("button", { name: "设预算" })));
    const dialog = await screen.findByRole("dialog", { name: "设置投放预算" });
    expect(within(dialog).getByRole("textbox", { name: "总预算（灵豆）" })).toHaveValue("5000");
    expect(client.getGeoDistribution).toHaveBeenCalledWith("geo_masi");
  });

  it("says what is going on and when it measures next, in the band's one sentence", async () => {
    renderProject();
    await screen.findByRole("tablist", { name: "项目视图" });
    const rail = document.querySelector("[data-step-rail]") as HTMLElement;
    // 内容 and 投放 are running; the next measurement is the monitoring read's.
    await waitFor(() => expect(rail).toHaveTextContent(/正在写稿、投放 · 下次复测/));
    expect(rail.textContent).not.toMatch(/%/);
  });

  it("opens the answer a 本周 line quotes, whichever tab the server files it under; a line that quotes none lands on its tab", async () => {
    renderProject();
    expect(await screen.findByRole("link", { name: /DeepSeek 仍把用法说成/ })).toHaveAttribute("href", "/app/geo/geo_masi/answers/snap_2");
    expect(screen.getByRole("link", { name: /豆包在“打了减重针恶心/ })).toHaveAttribute("href", "/app/geo/geo_masi/answers/snap_1");
    expect(screen.getByRole("link", { name: /和司美格鲁肽怎么选/ })).toHaveAttribute("href", "/app/geo/geo_masi/sources");
    // 投放 is read on 行动 now, at its own block.
    expect(screen.getByRole("link", { name: /6 篇证据卡片已被百度收录/ })).toHaveAttribute("href", "/app/geo/geo_masi/actions#geo-delivery");
  });

  it("opens each tab with a heading of its own, so the outline never jumps from the title to a third-level block", async () => {
    renderProject();
    await screen.findByRole("tablist", { name: "项目视图" });
    const panel = document.getElementById("geo-tab-panel") as HTMLElement;
    const headings = [...panel.querySelectorAll("h2, h3")];
    expect(headings[0].tagName).toBe("H2");
    expect(headings[0]).toHaveTextContent("总览");
    expect(headings[0]).toHaveClass("sr-only");
    await userEvent.click(tabsOf().getByRole("tab", { name: "信源" }));
    await screen.findByTestId("sources-tab");
    expect(panel.querySelector("h2")).toHaveTextContent("信源");
  });

  it("folds the rail to one chip on a phone, with the steps in its menu, and keeps it on every tab", async () => {
    const real = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === "(max-width: 639px)", media: query, onchange: null, addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      client.getGeoProject.mockResolvedValue({ ...GEO_PROJECT, budget: null, market: { configured: false } });
      renderProject();
      const rail = await waitFor(() => {
        const found = document.querySelector("[data-step-rail]");
        expect(found).toBeTruthy();
        return found as HTMLElement;
      });
      expect(within(rail).getByRole("button", { name: /已完成 5\/8 步/ })).toBeInTheDocument();
      await userEvent.click(tabsOf().getByRole("tab", { name: "方案" }));
      await screen.findByTestId("plan-tab");
      expect(document.querySelectorAll("[data-step-rail]")).toHaveLength(1);
    } finally {
      window.matchMedia = real;
    }
  });

  it("marks the step that is waiting on the reader, and says what it waits for", async () => {
    client.getGeoProject.mockResolvedValue({ ...GEO_PROJECT, budget: null });
    renderProject();
    await screen.findByRole("tablist", { name: "项目视图" });
    const distribution = document.querySelector("[data-rail-step='distribution']") as HTMLElement;
    expect(distribution).toHaveAttribute("data-rail-state", "waiting");
    expect(distribution).toHaveTextContent("投放");
  });

  it("without a media market, asks for no budget and says what placing waits for", async () => {
    client.getGeoProject.mockResolvedValue({ ...GEO_PROJECT, budget: null, market: { configured: false } });
    renderProject();
    await screen.findByRole("tablist", { name: "项目视图" });
    // The step is untouched — it waits for the market, which is a tooltip — and nothing owes a budget.
    const distribution = document.querySelector("[data-rail-step='distribution']") as HTMLElement;
    expect(distribution).toHaveAttribute("data-rail-state", "todo");
    expect(screen.queryByText("待你确认预算")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "设预算" })).not.toBeInTheDocument();
  });

  it("opens with one sentence, the numbers with their targets, and the denominator said once", async () => {
    renderProject();
    // One sentence, and the whole of it: the measurement it needs has to have
    // arrived before any of it is asserted.
    expect(await screen.findByText(/综合可见度 38，比上次高 5，目标 55，提及率在 2 个同类药里排第 2；还有 1 条严重讲错待处理。/)).toBeInTheDocument();

    // The index takes two cells, with where we stand, the target, and the
    // rival ahead of us (fusion plan §4.8).
    const gvi = screen.getByRole("group", { name: "综合可见度指数" });
    expect(gvi).toHaveTextContent("38");
    expect(gvi).toHaveTextContent("目标 55");
    expect(gvi).toHaveTextContent("提及率第 2 / 2");
    expect(gvi).toHaveTextContent("司美格鲁肽 提及率 48%");
    expect(gvi).toHaveClass("sm:col-span-2");
    // One reader name per metric id: the overview's mention is M-01S, 品类问题可见率 — never 品牌提及率, which is M-01.
    const mention = screen.getByRole("group", { name: "品类问题可见率" });
    expect(mention).toHaveTextContent("18");
    expect(mention).toHaveTextContent("目标 35%");
    expect(screen.queryByRole("group", { name: "品牌提及率" })).not.toBeInTheDocument();
    // 24 answers: the rate is withheld and the number never printed.
    const citation = screen.getByRole("group", { name: "引用命中率" });
    expect(citation).toHaveTextContent("样本不足");
    expect(citation).not.toHaveTextContent("6%");
    // The safety cell is the one red number, and it counts S3 and above only.
    expect(screen.getByRole("group", { name: "用药安全" })).toHaveTextContent("1");

    // The denominator is declared once for the band, not in each cell.
    const stats = screen.getByRole("region", { name: "本轮指标" });
    expect(within(stats).getByText(/按 3 个引擎、310 次有效回答计算/)).toBeInTheDocument();
    expect(within(stats).getAllByText(/次有效回答计算/)).toHaveLength(1);
  });

  it("has one AI entry, in the header — not one beside every number", async () => {
    renderProject();
    await screen.findByText(/按 3 个引擎、310 次有效回答计算/);
    expect(screen.queryAllByRole("button", { name: "问 AI" })).toHaveLength(0);
    expect(screen.getAllByRole("button", { name: "对话" })).toHaveLength(1);
  });

  it.each([
    ["/app/geo/geo_masi/diagnosis", "/app/geo/geo_masi/accuracy", "accuracy"],
    ["/app/geo/geo_masi/monitoring", "/app/geo/geo_masi/visibility", "visibility"],
    ["/app/geo/geo_masi/content", "/app/geo/geo_masi/actions", "actions"],
    ["/app/geo/geo_masi/distribution", "/app/geo/geo_masi/actions", "actions"],
    ["/app/geo/geo_masi/journey", "/app/geo/geo_masi/questions?view=journey", "questions"],
    ["/app/geo/geo_masi/evidence", "/app/geo/geo_masi/evidence", "evidence"],
    ["/app/geo/geo_masi/questions", "/app/geo/geo_masi/questions", "questions"],
    ["/app/geo/geo_masi/sources", "/app/geo/geo_masi/sources", "sources"],
  ])("an old address (%s) still lands: %s", async (from, to, testid) => {
    renderProject(from);
    expect(await screen.findByTestId(`${testid}-tab`)).toHaveTextContent("geo_masi:玛仕度肽注射液");
    await waitFor(() => expect(screen.getByTestId("landed")).toHaveTextContent(to));
  });

  it("switches tabs by address", async () => {
    renderProject();
    await userEvent.click(await screen.findByRole("tab", { name: "准确与安全" }));
    await waitFor(() => expect(screen.getByTestId("landed")).toHaveTextContent("/app/geo/geo_masi/accuracy"));
    expect(await screen.findByTestId("accuracy-tab")).toHaveTextContent("geo_masi:玛仕度肽注射液");
    await userEvent.click(screen.getByRole("tab", { name: "总览" }));
    await waitFor(() => expect(screen.getByTestId("landed")).toHaveTextContent(/^\/app\/geo\/geo_masi$/));
  });

  it("names the three measurement tabs 「AI 回答监测」 in the browser tab, and the others by the project", async () => {
    renderProject("/app/geo/geo_masi/accuracy");
    await screen.findByTestId("accuracy-tab");
    await waitFor(() => expect(document.title).toBe("玛仕度肽注射液 · AI 回答监测 · EviMed"));
    await userEvent.click(screen.getByRole("tab", { name: "信源" }));
    await waitFor(() => expect(document.title).toBe("玛仕度肽注射液 · EviMed"));
  });

  it("reads the project again, and the tabs' data with it, when a step of the programme changes state", async () => {
    // A step that ends begins: the page reads itself again while it is under way.
    client.getGeoProject.mockResolvedValue({ ...GEO_PROJECT, steps: { ...GEO_PROJECT.steps, diagnosis: { status: "running", requested: true } }, overview: { ...GEO_PROJECT.overview, steps: { ...GEO_PROJECT.overview.steps, diagnosis: { status: "running", requested: true } } } });
    renderProject();
    await screen.findByRole("tablist", { name: "项目视图" });
    expect(document.querySelector("[data-rail-step='diagnosis']")).toHaveAttribute("data-rail-state", "active");
    // The poll is a timer: the one read is all this test waits for.
    expect(client.getGeoProject).toHaveBeenCalledTimes(1);
  });

  it("offers a member only what their roles allow in the ⋯ menu: a viewer sees 项目设置 and nothing that changes the project", async () => {
    client.getGeoProject.mockResolvedValue({ ...GEO_PROJECT, access: { roles: ["viewer"], abilities: ["read"], owner: false } });
    renderProject();
    await userEvent.click(await screen.findByRole("button", { name: "更多操作" }));
    expect(screen.getByRole("menuitem", { name: "项目设置" })).toBeInTheDocument();
    for (const hidden of ["重命名", "导出提案资料包", "暂停", "删除"]) expect(screen.queryByRole("menuitem", { name: hidden })).not.toBeInTheDocument();
  });

  it("opens the project's settings in a drawer from ⋯: the engines, the window, the budget, who speaks for the product, the members", async () => {
    renderProject();
    await userEvent.click(await screen.findByRole("button", { name: "更多操作" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "项目设置" }));
    const drawer = await screen.findByRole("dialog", { name: "项目设置" });
    for (const row of ["测量的 AI 引擎", "覆盖周期", "投放预算", "出品方", "成员"]) expect(within(drawer).getByRole("region", { name: row })).toBeInTheDocument();
    expect(within(drawer).getByText("8,000 灵豆 · 每天最多 800 灵豆")).toBeInTheDocument();
  });

  it("a viewer has no button that continues a step", async () => {
    client.getGeoProject.mockResolvedValue({ ...GEO_PROJECT, access: { roles: ["viewer"], abilities: ["read"], owner: false } });
    renderProject("/app/geo/geo_masi/evidence");
    await screen.findByTestId("evidence-tab");
    expect(screen.queryByRole("button", { name: "让 AI 补充结论" })).not.toBeInTheDocument();
  });

  it("“对话” opens the project's latest conversation, “周报” exports it", async () => {
    client.exportGeo.mockResolvedValue({ sessionId: "ses_export", runId: "run_1" });
    renderProject();
    await userEvent.click(await screen.findByRole("button", { name: "对话" }));
    await waitFor(() => expect(client.open).toHaveBeenCalledWith({ projectId: "p-masi", sessionId: "ses_geo_masi" }));

    await userEvent.click(screen.getByRole("button", { name: "周报" }));
    await waitFor(() => expect(client.exportGeo).toHaveBeenCalledWith("geo_masi", "weekly"));
  });

  it("“⋯” exports the pack, pauses and deletes — deleting only after a confirmation", async () => {
    client.exportGeo.mockResolvedValue({ sessionId: "ses_export", runId: "run_1" });
    renderProject();
    await userEvent.click(await screen.findByRole("button", { name: "更多操作" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["重命名", "项目设置", "导出提案资料包", "暂停", "删除"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "导出提案资料包" }));
    await waitFor(() => expect(client.exportGeo).toHaveBeenCalledWith("geo_masi", "proposal"));

    await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "暂停" }));
    await waitFor(() => expect(client.patchGeoProject).toHaveBeenCalledWith("geo_masi", { status: "paused" }));

    await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    expect(client.deleteGeoProject).not.toHaveBeenCalled();
    const dialog = screen.getByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(client.deleteGeoProject).toHaveBeenCalledWith("geo_masi"));
    await waitFor(() => expect(screen.getByTestId("landed")).toHaveTextContent(/^\/app\/geo$/));
  });

  // 2026-10-07 plan §7: the name a project is listed by is the researcher's to change, here as it is in the sidebar's own pencil.
  it("“⋯” renames the project: the name is one line of at most 40 characters, saved, and the page and the sidebar read it again", async () => {
    renderProject();
    await userEvent.click(await screen.findByRole("button", { name: "更多操作" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    const dialog = screen.getByRole("dialog", { name: "重命名" });
    const field = within(dialog).getByRole("textbox", { name: "项目名" });
    expect(field).toHaveValue("玛仕度肽注射液");
    // Nothing is sent for an empty or unchanged name.
    await userEvent.clear(field);
    await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("请给项目起个名字。");
    expect(client.patchGeoProject).not.toHaveBeenCalled();
    client.getGeoProject.mockClear();
    client.getGeoProject.mockResolvedValue({ ...GEO_PROJECT, name: "玛仕度肽（2026 方案）" });
    await userEvent.type(field, "玛仕度肽（2026 方案）");
    await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(client.patchGeoProject).toHaveBeenCalledWith("geo_masi", { name: "玛仕度肽（2026 方案）" }));
    expect(await screen.findByRole("heading", { level: 1, name: "玛仕度肽（2026 方案）" })).toBeInTheDocument();
    expect(client.getGeoProject).toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "重命名" })).not.toBeInTheDocument();
  });

  it("a rename that fails says so in the dialog and keeps the typed name", async () => {
    client.patchGeoProject.mockRejectedValue(new WebApiError("no", { status: 500 }));
    renderProject();
    await userEvent.click(await screen.findByRole("button", { name: "更多操作" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    const dialog = screen.getByRole("dialog", { name: "重命名" });
    const field = within(dialog).getByRole("textbox", { name: "项目名" });
    await userEvent.clear(field); await userEvent.type(field, "新名字");
    await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(await within(dialog).findByRole("alert")).toBeInTheDocument();
    expect(field).toHaveValue("新名字");
    expect(screen.getByRole("dialog", { name: "重命名" })).toBeInTheDocument();
  });

  it("reads as a new project before anything was measured: “—” and a sentence, never a zero", async () => {
    client.getGeoProject.mockResolvedValue({
      ...GEO_PROJECT, name: "新循证 GEO 项目", steps: {}, budget: null, sessionId: "ses_new",
      overview: { metrics: [], week: [], steps: {} },
    });
    client.getGeoDiagnosis.mockResolvedValue({ round: null, rounds: [], byEngine: [], byPool: [], failureModes: {}, errors: [], noise: null, more: [] });
    client.getGeoMonitoring.mockResolvedValue({ series: [], arms: { pilot: [], control: [], netEffect: {} }, byEngine: [], cited: [], newErrors: [], next: null });
    renderProject();
    await screen.findByRole("tablist", { name: "项目视图" });
    expect([...document.querySelectorAll("[data-step-rail] [data-rail-state]")].map((step) => step.getAttribute("data-rail-state"))).toEqual(Array(8).fill("todo"));
    expect(await screen.findByText(/还没有测过各家 AI 怎么回答这个产品/)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "品类问题可见率" })).toHaveTextContent("—");
    expect(screen.queryByRole("button", { name: "问 AI" })).not.toBeInTheDocument();
  });

  it("starts over on a switch to another project: nothing of the first one is shown, or acted on, while the second is read", async () => {
    let answer: (project: typeof GEO_PROJECT) => void = () => undefined;
    client.getGeoProject.mockImplementation((id: string) => (id === "geo_masi"
      ? Promise.resolve(GEO_PROJECT)
      : new Promise((resolve) => { answer = resolve; })));
    function Switch() {
      const navigate = useNavigate();
      return <button type="button" onClick={() => navigate("/app/geo/geo_other/visibility")}>另一个项目</button>;
    }
    render(
      <MemoryRouter initialEntries={["/app/geo/geo_masi/visibility"]}>
        <Routes>
          <Route path="/app/geo/:geoId" element={<><GeoProjectLayout /><Switch /></>}>
            <Route path=":tab" element={null} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("visibility-tab")).toHaveTextContent("geo_masi:玛仕度肽注射液");

    await userEvent.click(screen.getByRole("button", { name: "另一个项目" }));
    expect(screen.queryByRole("heading", { level: 1, name: "玛仕度肽注射液" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("visibility-tab")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "更多操作" })).not.toBeInTheDocument();

    answer({ ...GEO_PROJECT, id: "geo_other", projectId: "p-other", name: "另一个产品" });
    expect(await screen.findByRole("heading", { level: 1, name: "另一个产品" })).toBeInTheDocument();
    expect(screen.getByTestId("visibility-tab")).toHaveTextContent("geo_other:另一个产品");
  });

  it("says a project that is gone is gone", async () => {
    client.getGeoProject.mockRejectedValue(new WebApiError("missing", { status: 404, code: "not_found" }));
    renderProject("/app/geo/geo_gone");
    expect(await screen.findByText("这个项目不存在或已删除。")).toBeInTheDocument();
  });

  it("is the off page where the module is off", async () => {
    client.useGeoFeature.mockReturnValue("off");
    renderProject();
    expect(screen.getByText(GEO_OFF_SENTENCE)).toBeInTheDocument();
    expect(client.getGeoProject).not.toHaveBeenCalled();
  });
});
