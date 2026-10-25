import { act, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useSearchParams } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { GEO_PROJECT } from "@/components/geo/__fixtures__/geoProjects";
import { diagnosisFilled, diagnosisWith, monitoringFilled } from "@/components/geo/__fixtures__/geoTabs";
import { GEO_OFF_SENTENCE } from "@/components/geo/GeoStates";
import { GEO_TABS } from "@/components/geo/geoTabs";
import { useProjectStore } from "@/lib/projects";
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
  getGeoProgrammeRuns: vi.fn(),
  patchGeoProject: vi.fn(),
  deleteGeoProject: vi.fn(),
  open: vi.fn(),
  nativeOpen: vi.fn(),
}));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toasts }));

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
  getGeoProgrammeRuns: client.getGeoProgrammeRuns,
  patchGeoProject: client.patchGeoProject,
  deleteGeoProject: client.deleteGeoProject,
}));

vi.mock("@/lib/geoNativeClient",async original=>({...await original<typeof import("@/lib/geoNativeClient")>(),openGeoConversation:client.nativeOpen}));
vi.mock("@/components/geo/useOpenGeoConversation", () => ({ useOpenGeoConversation: () => client.open }));

const scroll = vi.hoisted(() => ({ scrollBlockToTop: vi.fn() }));
vi.mock("@/components/geo/geoScroll", () => scroll);

// The tabs other than 总览 have their own tests; here each is a marker that says the layout gave it the project — and, through the
// toolbar hook, one filter, so what the band does with a tab's controls can be read.
const marker = vi.hoisted(() => (name: string, useGeoToolbar: (toolbar: unknown) => void) => ({ geoId, project }: { geoId: string; project: { name: string } }) => {
  const [choice, setChoice] = useState("初始视图");
  useGeoToolbar({ filters: [{ kind: "chips", label: `${name} 的筛选`, options: [{ value: "a", label: "甲" }, { value: "b", label: "乙" }], value: "a", onChange: () => undefined }] });
  return <div data-testid={`${name}-tab`}>{geoId}:{project.name}<button onClick={() => setChoice("已选择的视图")}>{`${name} 调整视图`}</button><span>{choice}</span></div>;
});
const toolbarHook = vi.hoisted(() => async () => (await import("@/components/geo/geoFrame")).useGeoToolbar as (toolbar: unknown) => void);
// 总览 draws 可见度's ranking card (one implementation), so this module keeps its other exports.
vi.mock("@/components/geo/tabs/VisibilityTab", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/geo/tabs/VisibilityTab")>()),
  VisibilityTab: marker("visibility", await toolbarHook()),
}));
vi.mock("@/components/geo/tabs/AccuracyTab", async () => ({ AccuracyTab: marker("accuracy", await toolbarHook()) }));
vi.mock("@/components/geo/tabs/QuestionsTab", async () => ({ QuestionsTab: marker("questions", await toolbarHook()) }));
vi.mock("@/components/geo/tabs/SourcesTab", async () => ({ SourcesTab: marker("sources", await toolbarHook()) }));
vi.mock("@/components/geo/tabs/ActionsTab", async () => ({ ActionsTab: marker("actions", await toolbarHook()) }));
vi.mock("@/components/geo/tabs/PlanTab", async () => ({ PlanTab: marker("plan", await toolbarHook()) }));
vi.mock("@/components/geo/tabs/EvidenceTab", async () => ({ EvidenceTab: marker("evidence", await toolbarHook()), readableSourceRef: () => null }));

function Landed() {
  const location = useLocation();
  const navigate = useNavigate();
  const [, setSearch] = useSearchParams();
  return (
    <>
      <p data-testid="landed">{`${location.pathname}${location.search}${location.hash}`}</p>
      {/* What a filter chip does: the query is rewritten in place, the block's name stays in the address. */}
      <button type="button" onClick={() => navigate({ search: "?show=open", hash: "#geo-errors" }, { replace: true })}>改写查询</button>
      <button type="button" onClick={() => setSearch(previous => { const query = new URLSearchParams(previous); query.set("engine", "deepseek"); return query; })}>修改平台筛选</button>
      <button type="button" onClick={() => navigate("/app/geo/geo_masi/actions#geo-review")}>打开旧稿件链接</button>
    </>
  );
}

/** The project the way the app mounts it: one layout over the tab routes and the answer. */
function Routed() {
  return (
    <Routes>
      <Route path="/app/geo/:geoId" element={<><GeoProjectLayout /><Landed /></>}>
        <Route index element={null} />
        <Route path="answers/:snapshotId" element={<div data-testid="answer-page">一条回答</div>} />
        <Route path="chat/:sessionId?" element={null} />
        <Route path=":tab" element={null} />
      </Route>
      <Route path="/app/geo" element={<Landed />} />
    </Routes>
  );
}

function renderProject(path = "/app/geo/geo_masi") {
  return render(<MemoryRouter initialEntries={[path]}><Routed /></MemoryRouter>);
}

describe("GEO analytical scope", () => {
  it("keeps the current workbench's local choices while changing a platform scope", async () => {
    const user = userEvent.setup();
    renderProject("/app/geo/geo_masi/visibility");
    await user.click(await screen.findByRole("button", { name: "visibility 调整视图" }));
    await user.click(screen.getByRole("button", { name: "修改平台筛选" }));
    await waitFor(() => expect(client.getGeoProject).toHaveBeenLastCalledWith("geo_masi", { engines: ["deepseek"] }));
    expect(await screen.findByText("已选择的视图")).toBeVisible();
  });
  it("carries a copied range into project, diagnosis and monitoring reads", async () => {
    renderProject("/app/geo/geo_masi?from=2026-10-01&to=2026-10-02&engine=kimi&cluster=g1&session=ses_keep");
    const scope = { from: "2026-10-01", to: "2026-10-02", engines: ["kimi"], groupIds: ["g1"] };
    await waitFor(() => expect(client.getGeoProject).toHaveBeenCalledWith("geo_masi", scope));
    await waitFor(() => expect(client.getGeoDiagnosis).toHaveBeenCalledWith("geo_masi", scope));
    await waitFor(() => expect(client.getGeoMonitoring).toHaveBeenCalledWith("geo_masi", scope));
    expect(await screen.findByRole("button", { name: "分析范围 · 已筛选" })).toBeVisible();
  });

  it("does not label a previous range's metrics as the new range while the new project read is pending", async () => {
    const user = userEvent.setup();
    let finish: (project: typeof GEO_PROJECT) => void = () => undefined;
    const delayed = new Promise<typeof GEO_PROJECT>(resolve => { finish = resolve; });
    client.getGeoProject.mockResolvedValueOnce(GEO_PROJECT).mockReturnValueOnce(delayed);
    renderProject();
    await screen.findByRole("button", { name: "分析范围" });
    await user.click(screen.getByRole("button", { name: "修改平台筛选" }));
    await waitFor(() => expect(client.getGeoProject).toHaveBeenLastCalledWith("geo_masi", { engines: ["deepseek"] }));
    expect(document.querySelector('[data-geo-tab="overview"]')).not.toBeVisible();
    await act(async () => { finish(GEO_PROJECT); await delayed; });
    await screen.findByRole("button", { name: "分析范围 · 已筛选" });
  });
});

/** The measured round, with one statement severe enough to reach a patient. */
const severeDiagnosis = diagnosisWith([
  { ...diagnosisFilled.errors[0], id: "err_s3", severity: "S3" as const, statement: "甲状腺结节患者禁用信尔美", status: "open" as const },
  diagnosisFilled.errors[0],
]);

beforeEach(() => {
  vi.clearAllMocks();
  client.nativeOpen.mockImplementation(async (geoId,target)=>({projectId:GEO_PROJECT.projectId,sessionId:target.sessionId,scope:{kind:"geo",geoProjectId:geoId,sessionId:target.sessionId}}));
  useProjectStore.setState({ currentId: GEO_PROJECT.projectId });
  client.useGeoFeature.mockReturnValue("on");
  client.getGeoProject.mockResolvedValue(GEO_PROJECT);
  client.getGeoDiagnosis.mockResolvedValue(severeDiagnosis);
  client.getGeoMonitoring.mockResolvedValue(monitoringFilled);
  client.getGeoStrategy.mockRejectedValue(new Error("no plan in this test"));
  client.getGeoDistribution.mockResolvedValue({ budget: null, spentCny: 0, reservedCny: 0, suggestedBudgetCny: 5000, market: { configured: true }, orders: [], ownedLinks: [] });
  client.open.mockResolvedValue(true);
  client.getGeoProgrammeRuns.mockResolvedValue({ runs: [], nextCursor: null });
  client.patchGeoProject.mockResolvedValue({});
  client.deleteGeoProject.mockResolvedValue({});
});

async function chooseResult(label: string) {
  if (label === "总览") { await userEvent.click(await screen.findByRole("button", { name: "项目总览" })); return; }
  const steps: Record<string, string> = { "可见度": "诊断", "准确与安全": "诊断", "问题与回答": "问题", "信源": "信源", "行动": "内容", "方案": "信源", "依据": "证据" };
  await chooseStep(new RegExp(`^${steps[label]}`));
  if (["可见度", "准确与安全", "信源", "方案"].includes(label)) {
    await userEvent.click(await screen.findByRole("button", { name: /^分析视图：/ }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: label }));
  }
}
async function chooseStep(label: RegExp) {
  const text = label.source.replace(/^\^/, "").split(" ·")[0];
  const step = await screen.findByRole("link", { name: new RegExp(`^${text}`) });
  await userEvent.click(step);
}
const band = () => document.querySelector("[data-page-chrome]") as HTMLElement;

describe("a GEO project's page", () => {
  it("uses the eight-step workflow as its only business navigation", async () => {
    renderProject();
    expect(await screen.findByRole("heading", { level: 1, name: "玛仕度肽注射液" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "周报" })).toBeInTheDocument();
    expect(document.querySelectorAll("[data-rail-step]")).toHaveLength(8);
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(document.querySelectorAll("[data-step-rail]")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /^查看：/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "项目总览" })).toBeInTheDocument();
  });

  it("does not offer weekly generation to a read-only member", async () => {
    client.getGeoProject.mockResolvedValue({ ...GEO_PROJECT, access: { roles: ["reader"], abilities: ["read"] } });
    renderProject();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("button", { name: "周报" })).not.toBeInTheDocument();
  });

  it("keeps scope and session parameters while redirecting an old journey address", async () => {
    renderProject("/app/geo/geo_masi/journey?engines=deepseek&engines=qianwen&from=2026-10-01&session=ses_keep");
    await screen.findByTestId("questions-tab");
    const location = screen.getByTestId("landed").textContent ?? "";
    const url = new URL(location, "https://example.test");
    expect(url.searchParams.getAll("engines")).toEqual(["deepseek", "qianwen"]);
    expect(url.searchParams.get("session")).toBe("ses_keep");
    expect(url.searchParams.get("view")).toBe("journey");
  });

  it("keeps a legacy distribution bookmark in the distribution workbench with its anchor", async () => {
    renderProject("/app/geo/geo_masi/distribution?engine=deepseek&step=journey#geo-budget");
    await screen.findByTestId("actions-tab");
    expect(screen.getByRole("link", { name: /^投放/ })).toHaveAttribute("aria-current", "step");
    const url = new URL(screen.getByTestId("landed").textContent ?? "", "https://example.test");
    expect(url.searchParams.get("engine")).toBe("deepseek");
    expect(url.searchParams.get("step")).toBe("distribution");
    expect(url.hash).toBe("#geo-budget");
  });

  it.each([["actions#geo-budget", "投放", "distribution"], ["visibility#geo-trend", "监测", "monitoring"]])(
    "keeps the workbench of %s when a query update removes the anchor", async (address, label, step) => {
      renderProject(`/app/geo/geo_masi/${address}`);
      await screen.findByRole("heading", { level: 1 });
      expect(screen.getByRole("link", { name: new RegExp(`^${label}`) })).toHaveAttribute("aria-current", "step");
      await userEvent.click(screen.getByRole("button", { name: "修改平台筛选" }));
      expect(screen.getByRole("link", { name: new RegExp(`^${label}`) })).toHaveAttribute("aria-current", "step");
      expect(new URL(screen.getByTestId("landed").textContent ?? "", "https://example.test").searchParams.get("step")).toBe(step);
    },
  );

  it("refreshes ongoing content work even when the first five steps have finished", async () => {
    vi.useFakeTimers();
    const visible = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    try {
      const steps = Object.fromEntries(Object.keys(GEO_PROJECT.steps).map(key => [key, { status: key === "content" ? "running" : "done" }]));
      client.getGeoProject.mockResolvedValue({ ...GEO_PROJECT, steps, overview: { ...GEO_PROJECT.overview, steps } });
      renderProject("/app/geo/geo_masi/actions?step=content");
      await act(async () => { await Promise.resolve(); });
      expect(client.getGeoProject).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(10_001); });
      expect(client.getGeoProject).toHaveBeenCalledTimes(2);
    } finally { visible.mockRestore(); vi.useRealTimers(); }
  });

  it("refreshes independent data during quiet visible polling", async () => {
    vi.useFakeTimers();
    const visible = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    try {
      const steps = Object.fromEntries(Object.keys(GEO_PROJECT.steps).map(key => [key, { status: "done" }]));
      client.getGeoProject.mockResolvedValue({ ...GEO_PROJECT, steps, overview: { ...GEO_PROJECT.overview, steps } });
      renderProject("/app/geo/geo_masi/actions");
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      const before = client.getGeoMonitoring.mock.calls.length;
      expect(before).toBeGreaterThan(0);
      await act(async () => { await vi.advanceTimersByTimeAsync(30_001); });
      expect(client.getGeoMonitoring.mock.calls.length).toBeGreaterThan(before);
    } finally { visible.mockRestore(); vi.useRealTimers(); }
  });

  it("coalesces project polling instead of discarding every slow response", async () => {
    vi.useFakeTimers();
    const visible = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    try {
      let finish: (value: typeof GEO_PROJECT) => void = () => undefined;
      const slow = new Promise<typeof GEO_PROJECT>(resolve => { finish = resolve; });
      const steps = { ...GEO_PROJECT.steps, content: { status: "running" as const } };
      const working = { ...GEO_PROJECT, status: "active" as const, steps, overview: { ...GEO_PROJECT.overview, steps } };
      client.getGeoProject.mockResolvedValueOnce(working).mockReturnValueOnce(slow).mockResolvedValue({ ...working, name: "更新后的项目" });
      renderProject("/app/geo/geo_masi/actions");
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      await act(async () => { await vi.advanceTimersByTimeAsync(10_001); });
      expect(client.getGeoProject).toHaveBeenCalledTimes(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(10_001); });
      expect(client.getGeoProject).toHaveBeenCalledTimes(2);
      await act(async () => { finish({ ...GEO_PROJECT, name: "更新后的项目" }); await vi.advanceTimersByTimeAsync(1); });
      expect(screen.getByRole("heading", { level: 1, name: "更新后的项目" })).toBeInTheDocument();
      expect(client.getGeoProject).toHaveBeenCalledTimes(3);
    } finally { visible.mockRestore(); vi.useRealTimers(); }
  });

  it("scrolls a legacy replacement to its preserved target", async () => {
    const block = Object.assign(document.createElement("div"), { id: "geo-budget" });
    document.body.append(block);
    try {
      renderProject("/app/geo/geo_masi/distribution#geo-budget");
      await screen.findByTestId("actions-tab");
      await waitFor(() => expect(scroll.scrollBlockToTop).toHaveBeenCalledWith(block));
    } finally { block.remove(); }
  });

  it("keeps waiting for a delayed anchor after same-shell canonicalization", async () => {
    renderProject("/app/geo/geo_masi/evidence");
    await screen.findByTestId("evidence-tab");
    await userEvent.click(screen.getByRole("button", { name: "打开旧稿件链接" }));
    await waitFor(() => expect(screen.getByTestId("landed")).toHaveTextContent("step=content"));
    const block = Object.assign(document.createElement("div"), { id: "geo-review" });
    document.body.append(block);
    try { await waitFor(() => expect(scroll.scrollBlockToTop).toHaveBeenCalledWith(block)); }
    finally { block.remove(); }
  });

  it("defers queued project and data polling when a slow response finishes in the background", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "visible";
    const visible = vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    try {
      const steps = { ...GEO_PROJECT.steps, content: { status: "running" as const } };
      const working = { ...GEO_PROJECT, status: "active" as const, steps, overview: { ...GEO_PROJECT.overview, steps } };
      let finish: (value: typeof working) => void = () => undefined;
      client.getGeoProject.mockResolvedValueOnce(working).mockReturnValueOnce(new Promise<typeof working>(resolve => { finish = resolve; })).mockResolvedValue(working);
      renderProject("/app/geo/geo_masi/actions");
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      await act(async () => { await vi.advanceTimersByTimeAsync(20_001); });
      const readings = client.getGeoMonitoring.mock.calls.length;
      visibility = "hidden";
      await act(async () => { finish(working); await vi.advanceTimersByTimeAsync(1); });
      expect(client.getGeoProject).toHaveBeenCalledTimes(2);
      expect(client.getGeoMonitoring.mock.calls.length).toBe(readings);
      visibility = "visible";
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(1); });
      expect(client.getGeoProject).toHaveBeenCalledTimes(3);
      expect(client.getGeoMonitoring.mock.calls.length).toBeGreaterThan(readings);
    } finally { visible.mockRestore(); vi.useRealTimers(); }
  });

  // R19 (audit C A.1; the reverse of R11's "rail on 总览 only"): the band is the layout's, so it is the same on every tab — present,
  // fixed, eight steps, the rail before the tabs and the tabs before the body.
  it("keeps every result view reachable within its workflow step", async () => {
    renderProject();
    for (const tab of GEO_TABS) {
      await chooseResult(tab.label);
      expect(screen.queryByRole("button", { name: /^查看：/ })).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { level: 2, name: tab.label })).toBeInTheDocument();
      expect(band()).toHaveClass("sticky", "top-0");
      expect(document.querySelectorAll("[data-toolbar]")).toHaveLength(1);
      expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    }
  });

  it("keeps the answer inside its project with the questions result selected", async () => {
    renderProject("/app/geo/geo_masi/answers/snap_1");
    expect(await screen.findByTestId("answer-page")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^问题/ })).toHaveAttribute("aria-current", "step");
    expect(band()).toHaveClass("sticky");
  });

  it("keeps the selected workflow step and conversation in the result address", async () => {
    renderProject("/app/geo/geo_masi/actions?session=ses_second&step=distribution");
    await chooseResult("准确与安全");
    expect(screen.getByTestId("landed")).toHaveTextContent("/accuracy?session=ses_second&step=diagnosis");
    expect(screen.getByRole("link", { name: /^诊断/ })).toHaveAttribute("aria-current", "step");
  });

  it("takes workflow steps to their mapped result view and block", async () => {
    renderProject();
    await chooseStep(/^诊断 ·/);
    expect(await screen.findByTestId("accuracy-tab")).toBeInTheDocument();
    expect(screen.getByTestId("landed")).toHaveTextContent("/accuracy?session=ses_geo_masi&step=diagnosis#geo-errors");
    await chooseStep(/^旅程 ·/);
    expect(screen.getByTestId("landed")).toHaveTextContent("/questions?view=journey&session=ses_geo_masi&step=journey");
  });

  // The live walk: `scrollIntoView` also scrolls the app shell's clipped root and carried the sidebar and the band off the screen.
  // The page's own ground is the only thing an address with a block scrolls, through `scrollBlockToTop`.
  it("scrolls the block an address names through the page's ground, once it is on the page", async () => {
    const block = Object.assign(document.createElement("div"), { id: "geo-errors" });
    document.body.append(block);
    try {
      renderProject("/app/geo/geo_masi/accuracy#geo-errors");
      await screen.findByTestId("accuracy-tab");
      await waitFor(() => expect(scroll.scrollBlockToTop).toHaveBeenCalledWith(block));
      expect(scroll.scrollBlockToTop).toHaveBeenCalledTimes(1);
    } finally {
      block.remove();
    }
  });

  it("does not scroll a block again when only filters are replaced", async () => {
    const block = Object.assign(document.createElement("div"), { id: "geo-errors" });
    document.body.append(block);
    try {
      renderProject("/app/geo/geo_masi/accuracy#geo-errors");
      await screen.findByTestId("accuracy-tab");
      await waitFor(() => expect(scroll.scrollBlockToTop).toHaveBeenCalledWith(block));
      scroll.scrollBlockToTop.mockClear();
      await userEvent.click(screen.getByRole("button", { name: "改写查询" }));
      expect(screen.getByTestId("landed")).toHaveTextContent("show=open");
      expect(scroll.scrollBlockToTop).not.toHaveBeenCalled();
    } finally { block.remove(); }
  });

  it("scrolls to nothing where the block is not on the tab, and leaves the tab at its top", async () => {
    renderProject("/app/geo/geo_masi/visibility#geo-nowhere");
    await screen.findByTestId("visibility-tab");
    // The layout waits a moment for a block that may still be coming, then stops.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(scroll.scrollBlockToTop).not.toHaveBeenCalled();
  });

  it("draws the tab's controls in the band, above the body, and takes them away with the tab", async () => {
    renderProject("/app/geo/geo_masi/sources");
    const body = document.querySelector("[data-page-body]") as HTMLElement;
    const group = await screen.findByRole("group", { name: "sources 的筛选" });
    expect(band()).toContainElement(group);
    expect(body).not.toContainElement(group);
    // Before the body in the document, and the same one toolbar on the next tab.
    expect(group.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await chooseResult("方案");
    expect(await screen.findByRole("group", { name: "plan 的筛选" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "sources 的筛选" })).not.toBeInTheDocument();
    expect(document.querySelectorAll("[data-toolbar]")).toHaveLength(1);
    // 总览 has no controls: the row is reserved and empty, so the band does not change height.
    await chooseResult("总览");
    await waitFor(() => expect(document.querySelectorAll("[data-toolbar]")).toHaveLength(1));
    expect(band().lastElementChild).toHaveClass("min-h-11");
  });

  it("ends the toolbar with one text button that continues the tab's step, and only on the tabs that have one", async () => {
    renderProject("/app/geo/geo_masi/evidence");
    await screen.findByTestId("evidence-tab");
    const toolbar = () => document.querySelector("[data-toolbar]") as HTMLElement;
    // The chips of the marker's own filter are pressed-or-not buttons; the text button that continues the step is the one that is not.
    const buttons = () => [...toolbar().querySelectorAll("button:not([aria-pressed]):not([aria-haspopup])")].map((button) => button.textContent);
    await waitFor(() => expect(buttons()).toContain("让 AI 补充结论"));
    // It asks in the project's conversation, with the brief waiting unsent.
    await userEvent.click(within(toolbar()).getByRole("button", { name: "让 AI 补充结论" }));
    expect(client.open).toHaveBeenCalledWith({ geoId: "geo_masi", projectId: "p-masi", sessionId: "ses_geo_masi" }, expect.stringContaining("补充信尔美还没有覆盖的说明书内容"));

    await chooseResult("信源");
    await waitFor(() => expect(buttons()).toEqual(["分析范围", "选目标档"]));
    await userEvent.click(within(toolbar()).getByRole("button", { name: "选目标档" }));
    const planned = new URL(screen.getByTestId("landed").textContent ?? "", "https://example.test");
    expect(planned.pathname).toBe("/app/geo/geo_masi/plan");
    expect(planned.hash).toBe("#geo-targets");
    expect(planned.searchParams.get("step")).toBe("sources");
    expect(planned.searchParams.get("session")).toBe("ses_geo_masi");

    // Measured views offer the range, without starting another sampling run.
    await chooseResult("准确与安全");
    await waitFor(() => expect(buttons()).toEqual(["分析范围"]));
    await chooseResult("可见度");
    await waitFor(() => expect(buttons()).toEqual(["分析范围"]));

    // 行动 reads the range too (its analysis of articles and placing), so it says so.
    await chooseResult("行动");
    await waitFor(() => expect(buttons()).toEqual(["分析范围", "让 AI 写下一批"]));
  });

  it("offers the budget in distribution where a market is connected, with the tier's suggestion", async () => {
    client.getGeoProject.mockResolvedValue({ ...GEO_PROJECT, budget: null });
    renderProject("/app/geo/geo_masi/actions?step=distribution");
    const toolbar = () => document.querySelector("[data-toolbar]") as HTMLElement;
    await userEvent.click(await waitFor(() => within(toolbar()).getByRole("button", { name: "设预算" })));
    const dialog = await screen.findByRole("dialog", { name: "设置投放预算" });
    expect(within(dialog).getByRole("textbox", { name: "总预算（灵豆）" })).toHaveValue("5000");
    expect(client.getGeoDistribution).toHaveBeenCalledWith("geo_masi");
  });

  it("keeps truthful workflow statuses available in its progress menu", async () => {
    renderProject();
    await screen.findByRole("navigation", { name: "循证 GEO 进度" });
    expect(screen.getByRole("link", { name: /^内容.*进行中/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^投放.*进行中/ })).toBeInTheDocument();
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
    await screen.findByRole("heading", { level: 1 });
    const panel = document.querySelector("[data-page-body]") as HTMLElement;
    const headings = [...panel.querySelectorAll("h2, h3")];
    expect(headings[0].tagName).toBe("H2");
    expect(headings[0]).toHaveTextContent("总览");
    expect(headings[0]).toHaveClass("sr-only");
    await chooseResult("信源");
    await screen.findByTestId("sources-tab");
    expect(panel.querySelector("h2")).toHaveTextContent("信源");
  });

  it("keeps a conversation deep link inside the project shell and native pane", async () => {
    renderProject("/app/geo/geo_masi/chat/ses_geo_masi?step=evidence");
    expect(await screen.findByRole("heading", { name: "玛仕度肽注射液", level: 1 })).toBeInTheDocument();
    expect(screen.getByLabelText("项目对话")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^查看：/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^证据/ })).toHaveAttribute("aria-current", "step");
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("marks placing that waits on the reader in the workflow menu", async () => {
    client.getGeoProject.mockResolvedValue({ ...GEO_PROJECT, budget: null });
    renderProject();
    await screen.findByRole("navigation", { name: "循证 GEO 进度" });
    expect(screen.getByRole("link", { name: /^投放.*等你/ })).toBeInTheDocument();
  });

  it("without a media market offers no budget action", async () => {
    client.getGeoProject.mockResolvedValue({ ...GEO_PROJECT, budget: null, market: { configured: false } });
    renderProject();
    await screen.findByRole("heading", { level: 1 });
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
    await chooseResult("准确与安全");
    await waitFor(() => expect(screen.getByTestId("landed")).toHaveTextContent("/app/geo/geo_masi/accuracy"));
    expect(await screen.findByTestId("accuracy-tab")).toHaveTextContent("geo_masi:玛仕度肽注射液");
    await chooseResult("总览");
    await waitFor(() => expect(screen.getByTestId("landed")).toHaveTextContent(/^\/app\/geo\/geo_masi\?session=ses_geo_masi$/));
  });

  it("names the three measurement tabs 「AI 回答监测」 in the browser tab, and the others by the project", async () => {
    renderProject("/app/geo/geo_masi/accuracy");
    await screen.findByTestId("accuracy-tab");
    await waitFor(() => expect(document.title).toBe("玛仕度肽注射液 · AI 回答监测 · EviMed"));
    await chooseResult("信源");
    await waitFor(() => expect(document.title).toBe("玛仕度肽注射液 · EviMed"));
  });

  it("reads the project again, and the tabs' data with it, when a step of the programme changes state", async () => {
    // A step that ends begins: the page reads itself again while it is under way.
    client.getGeoProject.mockResolvedValue({ ...GEO_PROJECT, steps: { ...GEO_PROJECT.steps, diagnosis: { status: "running", requested: true } }, overview: { ...GEO_PROJECT.overview, steps: { ...GEO_PROJECT.overview.steps, diagnosis: { status: "running", requested: true } } } });
    renderProject();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.getByRole("navigation", { name: "循证 GEO 进度" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^诊断.*进行中/ })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    // The poll is a timer: the one read is all this test waits for.
    expect(client.getGeoProject).toHaveBeenCalledTimes(1);
  });

  it("offers a member only what their roles allow in the ⋯ menu: a viewer sees 项目设置 and nothing that changes the project", async () => {
    client.getGeoProject.mockResolvedValue({ ...GEO_PROJECT, access: { roles: ["viewer"], abilities: ["read"], owner: false } });
    renderProject();
    await userEvent.click(await screen.findByRole("button", { name: "更多操作" }));
    expect(screen.getByRole("menuitem", { name: "项目设置" })).toBeInTheDocument();
    // What the AI did in the background is readable by anyone who can read the project.
    expect(screen.getByRole("menuitem", { name: "AI 运行" })).toBeInTheDocument();
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

  it("“对话” opens the project's own conversation; “周报” and the pack start the work and keep the reader where they are", async () => {
    client.exportGeo.mockResolvedValue({ accepted: true, runId: "run_1", step: null });
    renderProject();
    await userEvent.click(await screen.findByRole("button", { name: "对话" }));
    await waitFor(() => expect(client.open).toHaveBeenCalledWith({ geoId: "geo_masi", projectId: "p-masi", sessionId: "ses_geo_masi" }));
    client.open.mockClear();

    await userEvent.click(screen.getByRole("button", { name: "周报" }));
    await waitFor(() => expect(client.exportGeo).toHaveBeenCalledWith("geo_masi", "weekly"));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("已开始生成周报。", expect.objectContaining({ action: expect.objectContaining({ label: "查看" }) })));
    // The run is a step of the programme, not a conversation: nothing opens, the reader stays on the page.
    expect(client.open).not.toHaveBeenCalled();
    expect(screen.getByTestId("landed")).toHaveTextContent(/^\/app\/geo\/geo_masi$/);
    // The page read itself again, so a step that began shows on the rail.
    await waitFor(() => expect(client.getGeoProject.mock.calls.length).toBeGreaterThan(1));
  });

  it("an export that waits for the project's run slot says so, and a refusal says why", async () => {
    client.exportGeo.mockResolvedValueOnce({ accepted: true, runId: null, step: null }).mockRejectedValueOnce(new WebApiError("no", { status: 409, code: "geo_project_paused" }));
    renderProject();
    await userEvent.click(await screen.findByRole("button", { name: "周报" }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("周报排在前一项之后，做完会自动开始。", expect.anything()));
    await userEvent.click(await screen.findByRole("button", { name: "周报" }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect(client.open).not.toHaveBeenCalled();
  });

  it("a project with no conversation of the person's yet opens a new one", async () => {
    client.getGeoProject.mockResolvedValue({ ...GEO_PROJECT, sessionId: null });
    renderProject();
    await userEvent.click(await screen.findByRole("button", { name: "对话" }));
    await waitFor(() => expect(client.open).toHaveBeenCalledWith({ geoId: "geo_masi", projectId: "p-masi", sessionId: null }));
  });

  it("“⋯” holds the AI-run record: the steps the programme ran, read where the reader is — and the toast of a start leads to it", async () => {
    client.exportGeo.mockResolvedValue({ accepted: true, runId: "run_1", step: null });
    client.getGeoProgrammeRuns.mockResolvedValue({ runs: [
      { sessionId: "ses_a", label: "写第 1 批稿件", state: "finished", at: "昨天 09:12" },
      { sessionId: "ses_b", label: "整理产品证据、绘制患者旅程、列出测量问题", state: "finished", at: "9月14日" },
    ], nextCursor: null });
    renderProject();
    await userEvent.click(await screen.findByRole("button", { name: "更多操作" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "AI 运行" }));
    const drawer = await screen.findByRole("dialog", { name: "AI 运行" });
    const rows = await within(drawer).findAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual(["写第 1 批稿件已完成 · 昨天 09:12", "整理产品证据、绘制患者旅程、列出测量问题已完成 · 9月14日"]);
    expect(client.getGeoProgrammeRuns).toHaveBeenCalledWith("geo_masi");
    expect(client.open).not.toHaveBeenCalled();
    await userEvent.click(within(drawer).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "AI 运行" })).toBeNull());

    // The toast a start leaves carries its way to the record.
    await userEvent.click(screen.getByRole("button", { name: "周报" }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    const action = (toasts.success.mock.calls.at(-1)?.[1] as { action: { onClick: () => void } }).action;
    act(() => action.onClick());
    expect(await screen.findByRole("dialog", { name: "AI 运行" })).toBeInTheDocument();
  });

  it("“⋯” exports the pack without leaving the page, pauses and deletes — deleting only after a confirmation", async () => {
    client.exportGeo.mockResolvedValue({ accepted: true, runId: "run_1", step: null });
    renderProject();
    await userEvent.click(await screen.findByRole("button", { name: "更多操作" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["重命名", "项目设置", "导出提案资料包", "AI 运行", "暂停", "删除"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "导出提案资料包" }));
    await waitFor(() => expect(client.exportGeo).toHaveBeenCalledWith("geo_masi", "proposal"));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("已开始生成提案资料包。", expect.anything()));
    expect(client.open).not.toHaveBeenCalled();

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
    await screen.findByRole("heading", { level: 1 });
    expect(document.querySelectorAll('[data-rail-state="todo"]')).toHaveLength(8);
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
            <Route path="chat/:sessionId?" element={null} />
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

describe("a GEO project that is not being measured", () => {
  const PAUSED = { state: "paused" as const, since: "2026-10-20T04:00:00.000Z", engines: ["doubao", "qianwen", "deepseek", "yuanbao", "kimi"] };

  it("says 已暂停 in the header with 继续 beside it when its owner paused it, and promises no next round", async () => {
    client.getGeoProject.mockResolvedValue({ ...GEO_PROJECT, status: "paused" });
    renderProject();
    expect(await screen.findByText(/^已暂停 · /)).toBeInTheDocument();
    await waitFor(() => expect(client.getGeoMonitoring).toHaveBeenCalled());
    expect(band()).not.toHaveTextContent(/下次复测|待复测/);
    await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect(screen.queryByRole("menuitem", { name: "暂停" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "继续" })).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "继续" }));
    await waitFor(() => expect(client.patchGeoProject).toHaveBeenCalledWith("geo_masi", { status: "active" }));
  });

  it("says in the band, on every view, that the measurement is paused and since when — and no next round", async () => {
    client.getGeoMonitoring.mockResolvedValue({ ...monitoringFilled, next: { date: "2026-10-26", kind: "weekly" }, measurement: PAUSED });
    renderProject("/app/geo/geo_masi/chat/ses_geo_masi");
    await waitFor(() => expect(band()).toHaveTextContent("AI 回答测量暂停中（10月20日起）"));
    expect(band()).not.toHaveTextContent(/下次复测|待复测/);
  });

  it("names the engines that are paused while the others are measured, and keeps the next round", async () => {
    client.getGeoMonitoring.mockResolvedValue({ ...monitoringFilled, next: { date: "2099-01-05", kind: "weekly" }, measurement: { state: "measuring", since: null, engines: ["doubao", "kimi"] } });
    renderProject();
    await waitFor(() => expect(band()).toHaveTextContent("豆包、Kimi 暂停测量"));
    expect(band()).toHaveTextContent("下次复测");
  });

  it("marks on the rail only a step whose result is on the page, and keeps the person's selection for the views built from it", async () => {
    renderProject("/app/geo/geo_masi/evidence?step=monitoring");
    await screen.findByTestId("evidence-tab");
    const marked = () => [...document.querySelectorAll("[data-rail-step]")].filter((node) => node.querySelector("[aria-current='step']")).map((node) => node.getAttribute("data-rail-step"));
    expect(marked()).toEqual(["evidence"]);
    await chooseResult("可见度");
    await screen.findByTestId("visibility-tab");
    expect(screen.getByTestId("landed")).toHaveTextContent("step=monitoring");
    expect(marked()).toEqual(["monitoring"]);
  });
});

describe("the project's conversation for a role that may not converse", () => {
  const viewer = { ...GEO_PROJECT, access: { roles: ["viewer"], abilities: ["read"], owner: false } };
  it("「对话」 reads the kept conversation, never asks to open one", async () => {
    client.getGeoProject.mockResolvedValue(viewer);
    renderProject("/app/geo/geo_masi/visibility");
    await userEvent.click(await screen.findByRole("button", { name: "对话" }));
    await waitFor(() => expect(screen.getByTestId("landed")).toHaveTextContent(/^\/app\/geo\/geo_masi\/chat\/ses_geo_masi\?.*result=visibility/));
    expect(client.open).not.toHaveBeenCalled();
    expect(client.nativeOpen).not.toHaveBeenCalled();
  });

  it("offers no 「对话」 where there is no conversation to read, and the bare conversation address says so instead of loading forever", async () => {
    client.getGeoProject.mockResolvedValue({ ...viewer, sessionId: null });
    renderProject();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("button", { name: "对话" })).not.toBeInTheDocument();
    renderProject("/app/geo/geo_masi/chat");
    expect(await screen.findByText("这个项目还没有对话")).toBeInTheDocument();
    expect(client.open).not.toHaveBeenCalled();
  });

  it("the bare conversation address goes to the kept conversation", async () => {
    client.getGeoProject.mockResolvedValue(viewer);
    renderProject("/app/geo/geo_masi/chat");
    await waitFor(() => expect(screen.getByTestId("landed")).toHaveTextContent(/^\/app\/geo\/geo_masi\/chat\/ses_geo_masi/));
    expect(client.open).not.toHaveBeenCalled();
  });

  it("for a role that may, a conversation that cannot be opened says so with 重试, which asks again", async () => {
    client.open.mockResolvedValue(false);
    renderProject("/app/geo/geo_masi/chat");
    expect(await screen.findByRole("alert")).toHaveTextContent("对话暂时无法打开，请稍后重试。");
    expect(client.open).toHaveBeenCalledTimes(1);
    client.open.mockResolvedValue(true);
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(client.open).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });
});

describe("a saved selection whose data changed", () => {
  it("offers to read the latest data in the same range, instead of a 重试更新 that sends the stale reference again", async () => {
    const range = { from: "2026-10-01", to: "2026-10-14" };
    client.getGeoProject.mockResolvedValueOnce({ ...GEO_PROJECT, scope: { ...range, selectionRef: "gsel_old" } })
      .mockRejectedValue(new WebApiError("The saved selection changed after measurement.", { status: 409, code: "geo_read_filter_invalid" }));
    renderProject("/app/geo/geo_masi/visibility?selectionRef=gsel_old&from=2026-10-01&to=2026-10-14");
    await screen.findByTestId("visibility-tab");
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    const note = await screen.findByText(/所选范围里的数据已经更新/);
    expect(screen.queryByRole("button", { name: "重试更新" })).not.toBeInTheDocument();
    client.getGeoProject.mockResolvedValue({ ...GEO_PROJECT, scope: range });
    await userEvent.click(within(note.closest("[data-note]") ?? note.parentElement!).getByRole("button", { name: "读取最新结果" }));
    await waitFor(() => expect(screen.getByTestId("landed")).not.toHaveTextContent("selectionRef"));
    expect(screen.getByTestId("landed")).toHaveTextContent("from=2026-10-01");
    await waitFor(() => expect(screen.queryByText(/所选范围里的数据已经更新/)).not.toBeInTheDocument());
  });
});

describe("watching a project", () => {
  it("reads the shared views again only when a step or the project moved, not on every poll", async () => {
    renderProject();
    await waitFor(() => expect(client.getGeoMonitoring).toHaveBeenCalled());
    await waitFor(() => expect(client.getGeoProject).toHaveBeenCalledTimes(1));
    const before = client.getGeoMonitoring.mock.calls.length;
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await waitFor(() => expect(client.getGeoProject).toHaveBeenCalledTimes(2));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(client.getGeoMonitoring.mock.calls.length).toBe(before);
    client.getGeoProject.mockResolvedValue({ ...GEO_PROJECT, updatedAt: "2099-01-01T00:00:00.000Z" });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await waitFor(() => expect(client.getGeoMonitoring.mock.calls.length).toBeGreaterThan(before));
  });
});

describe("the analysis range", () => {
  it("is shown on every view that reads it — 行动, 方案 and 依据 included — and not on one that reads none", async () => {
    const query = "from=2026-10-01&to=2026-10-14";
    for (const [path, shown] of [["actions?step=content", true], ["plan?step=sources", true], ["evidence", true], ["actions?step=monitoring", false]] as const) {
      const view = renderProject(`/app/geo/geo_masi/${path}${path.includes("?") ? "&" : "?"}${query}`);
      await screen.findByRole("heading", { level: 1 });
      await waitFor(() => expect(document.querySelector("[data-toolbar]")).not.toBeNull());
      if (shown) expect(await screen.findByRole("button", { name: "分析范围 · 已筛选" })).toBeVisible();
      else expect(screen.queryByRole("button", { name: /^分析范围/ })).not.toBeInTheDocument();
      view.unmount();
    }
  });
});
