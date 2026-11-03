import { sessionOwner } from "@/lib/sessionLifecycle";
import { prepareRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useSearchParams } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { GEO_PROJECT } from "@/components/geo/__fixtures__/geoProjects";
import { diagnosisFilled, diagnosisWith, monitoringFilled } from "@/components/geo/__fixtures__/geoTabs";
import { GEO_OFF_SENTENCE } from "@/components/geo/GeoStates";
import { useGeoAnswerBack } from "@/components/geo/geoFrame";
import { GEO_STEP_HOME, GEO_TABS, geoDestinationPath } from "@/components/geo/geoTabs";
import { geoPathWithContext } from "@/components/geo/useGeoPath";
import type { GeoStepKey } from "@/lib/geoClient";
import { CONVERSATION_SETTLED_EVENT } from "@/lib/runtimeUiBridge";
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
  stopGeoStepRun: vi.fn(),
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
  stopGeoStepRun: client.stopGeoStepRun,
}));

vi.mock("@/lib/geoNativeClient",async original=>({...await original<typeof import("@/lib/geoNativeClient")>(),openGeoConversation:client.nativeOpen}));
// The header's own open runs the real hook in one test (the stub elsewhere records only the target the page names).
const realOpen = vi.hoisted(() => ({ on: false }));
vi.mock("@/components/geo/useOpenGeoConversation", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/geo/useOpenGeoConversation")>();
  return { ...real, useOpenGeoConversation: () => { const open = real.useOpenGeoConversation(); return realOpen.on ? open : client.open; } };
});

const scroll = vi.hoisted(() => ({ scrollBlockToTop: vi.fn() }));
vi.mock("@/components/geo/geoScroll", () => scroll);

// The tabs other than 总览 have their own tests; here each is a marker that says the layout gave it the project — and, through the
// toolbar hook, one filter, so what the band does with a tab's controls can be read.
const marker = vi.hoisted(() => (name: string, useGeoToolbar: (toolbar: unknown) => void) => ({ geoId, project }: { geoId: string; project: { name: string } }) => {
  const [choice, setChoice] = useState("初始视图");
  useGeoToolbar({ navigation: [{kind:"select",label:`${name} 的业务视图`,value:"business",options:[{value:"business",label:"当前业务结果"}],onChange:()=>undefined}], filters: [{ kind: "chips", label: `${name} 的筛选`, options: [{ value: "a", label: "甲" }, { value: "b", label: "乙" }], value: "a", onChange: () => undefined }] });
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

vi.mock("@/components/geo/GeoAnalysisWorkbench", async () => { const hook = await toolbarHook(); return { GeoAnalysisWorkbench: ({ mainArea }: { mainArea: {descriptor: {viewId: string}; onChange(descriptor: {viewId: string; topN?: number}): void} }) => {
  hook({ summary: "所选分析", filters: [{kind:"select",label:"分析维度",value:"project",options:[{value:"project",label:"整体"}],onChange:()=>undefined}] });
  return <div data-testid="analysis-main">{mainArea.descriptor.viewId}<button type="button" onClick={() => mainArea.onChange({ ...mainArea.descriptor, topN: 30 })}>改分析筛选</button></div>;
} }; });

function Landed() {
  const location = useLocation();
  const navigate = useNavigate();
  const [, setSearch] = useSearchParams();
  return (
    <>
      <button type="button" onClick={() => { const target = (window as unknown as { __geoTestDestination: string }).__geoTestDestination; navigate(geoPathWithContext(target, location)); }}>模拟侧栏导航</button>
      <p data-testid="landed">{`${location.pathname}${location.search}${location.hash}`}</p>
      <output aria-label="Project navigation state">{JSON.stringify(location.state)}</output>
      {/* What a filter chip does: the query is rewritten in place, the block's name stays in the address. */}
      <button type="button" onClick={() => navigate({ search: "?show=open", hash: "#geo-errors" }, { replace: true })}>改写查询</button>
      <button type="button" onClick={() => setSearch(previous => { const query = new URLSearchParams(previous); query.set("engine", "deepseek"); return query; })}>修改平台筛选</button>
      <button type="button" onClick={() => navigate("/app/geo/geo_masi/actions#geo-review")}>打开旧稿件链接</button>
      <button type="button" onClick={() => navigate(-1)}>后退一步</button>
      <button type="button" onClick={() => navigate("/app/geo/geo_masi/answers/snap_1?back=accuracy")}>看回答</button>
      <button type="button" onClick={() => navigate(geoPathWithContext("/app/geo/geo_masi/answers/snap_1?back=questions", location))}>从问题进入回答</button>
    </>
  );
}

/** The answer as the layout holds it: only what the page needs of it, which is where its way back goes (`?back=` names it for a test). */
function AnswerStub() {
  const [search] = useSearchParams();
  useGeoAnswerBack(search.get("back") === "accuracy" ? "accuracy" : "questions");
  return <div data-testid="answer-page">一条回答</div>;
}

/** The project the way the app mounts it: one layout over the tab routes and the answer. */
function Routed() {
  return (
    <Routes>
      <Route path="/app/geo/:geoId" element={<><GeoProjectLayout /><Landed /></>}>
        <Route index element={null} />
        <Route path="answers/:snapshotId" element={<AnswerStub />} />
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
  it("carries a copied range into the project and monitoring reads", async () => {
    renderProject("/app/geo/geo_masi/visibility?from=2026-10-01&to=2026-10-02&engine=kimi&cluster=g1&session=ses_keep");
    const scope = { from: "2026-10-01", to: "2026-10-02", engines: ["kimi"], groupIds: ["g1"] };
    await waitFor(() => expect(client.getGeoProject).toHaveBeenCalledWith("geo_masi", scope));
    await waitFor(() => expect(client.getGeoMonitoring).toHaveBeenCalledWith("geo_masi", scope));
    expect(await screen.findByRole("button", { name: "分析范围 · 已筛选" })).toBeVisible();
  });

  it("does not label a previous range's metrics as the new range while the new project read is pending", async () => {
    const user = userEvent.setup();
    let finish: (project: typeof GEO_PROJECT) => void = () => undefined;
    const delayed = new Promise<typeof GEO_PROJECT>(resolve => { finish = resolve; });
    client.getGeoProject.mockResolvedValueOnce(GEO_PROJECT).mockReturnValueOnce(delayed);
    renderProject("/app/geo/geo_masi/visibility");
    await screen.findByRole("button", { name: "分析范围" });
    await user.click(screen.getByRole("button", { name: "修改平台筛选" }));
    await waitFor(() => expect(client.getGeoProject).toHaveBeenLastCalledWith("geo_masi", { engines: ["deepseek"] }));
    expect(screen.getByTestId("visibility-tab")).not.toBeVisible();
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
  realOpen.on = false;
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

async function navigateLikeSidebar(path: string) {
  (window as unknown as { __geoTestDestination: string }).__geoTestDestination = path;
  await userEvent.click(screen.getByRole("button", { name: "模拟侧栏导航" }));
}
async function chooseResult(label: string) {
  const routes: Record<string, string> = { "总览": "", "可见度": "visibility", "准确与安全": "accuracy", "问题与回答": "questions", "信源": "sources", "行动": "actions", "方案": "plan", "依据": "evidence" };
  const actualLabel: Record<string, string> = { "可见度": "可见度", "准确与安全": "医学核查", "信源": "引用来源", "问题与回答": "问题与回答" };
  const tab = actualLabel[label] && screen.queryByRole("tab", { name: actualLabel[label] });
  if (tab) await userEvent.click(tab);
  else await navigateLikeSidebar(`/app/geo/geo_masi${routes[label] ? `/${routes[label]}` : ""}`);
}
async function chooseStep(label: RegExp) {
  const steps: Record<string, GeoStepKey> = { "证据": "evidence", "旅程": "journey", "问题": "questions", "诊断": "diagnosis", "信源": "sources", "内容": "content", "投放": "distribution", "监测": "monitoring" };
  const name = label.source.replace(/^\^/, "").split(" ·")[0];
  const step = steps[name];
  if (!step) throw new Error(`Unknown step: ${name}`);
  await navigateLikeSidebar(geoDestinationPath("geo_masi", GEO_STEP_HOME[step]));
}
const band = () => document.querySelector("[data-page-chrome]") as HTMLElement;

describe("a GEO project's page", () => {
  it("shows four analysis views without a global step rail or bottom composer", async () => {
    renderProject("/app/geo/geo_masi/visibility");
    const tabs = await screen.findByRole("tablist", { name: "AI 表现" });
    expect(within(tabs).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["可见度", "医学核查", "引用来源", "问题与回答"]);
    expect(document.querySelector("[data-step-rail]")).toBeNull();
    expect(document.querySelector("[data-page-dock]")).toBeNull();
    expect(screen.getByRole("button", { name: "询问 AI" })).toBeVisible();
  });

  it("keeps the exact answer beside an explicitly addressed conversation", async () => {
    const media = vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
      matches: query.includes("1180"), media: query, onchange: null,
      addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false,
    }) as unknown as MediaQueryList);
    try {
      renderProject("/app/geo/geo_masi/answers/snap_1?conversation=open&session=ses_geo_masi#source");
      await waitFor(() => expect(document.querySelector('[aria-label="项目对话"]')).toBeInTheDocument());
      expect(screen.getByTestId("answer-page")).toBeInTheDocument();
      expect(screen.getByTestId("landed")).toHaveTextContent("/answers/snap_1?conversation=open&session=ses_geo_masi#source");
    } finally { media.mockRestore(); }
  });

  it("keeps a direct answer's fallback after closing its conversation", async () => {
    renderProject("/app/geo/geo_masi/answers/snap_1?conversation=open&session=ses_geo_masi#source");
    await userEvent.click(await screen.findByRole("link", { name: "回到结果" }));
    expect(await screen.findByRole("link", { name: "返回问题与回答" })).toHaveAttribute("href", expect.stringContaining("/questions"));
    expect(screen.getByTestId("answer-page")).toBeInTheDocument();
  });

  it("opens project settings from the contextual navigation without keeping the command in the address", async () => {
    renderProject("/app/geo/geo_masi/visibility?engines=kimi&panel=settings");
    expect(await screen.findByRole("dialog", { name: "项目设置" })).toBeVisible();
    expect(screen.getByTestId("landed")).not.toHaveTextContent("panel=settings");
    expect(screen.getByTestId("landed")).toHaveTextContent("engines=kimi");
  });

  it("keeps project status and reporting without a persistent eight-step rail", async () => {
    renderProject();
    expect(await screen.findByRole("heading", { level: 1, name: "玛仕度肽注射液" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "生成周报" })).toHaveAttribute("data-action-kind", "start");
    expect(document.querySelectorAll("[data-step-rail]")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /^查看：/ })).not.toBeInTheDocument();
    // 项目总览 is the band's back link (v3.2), not a header button.
    expect(screen.queryByRole("button", { name: "项目总览" })).not.toBeInTheDocument();
    expect(screen.getByText(/^项目第 \d+ 周$/)).toBeVisible();
    await userEvent.hover(screen.getByText(/^项目第 \d+ 周$/));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("按项目开始日期计算。");
  });

  it("does not offer weekly generation to a read-only member", async () => {
    client.getGeoProject.mockResolvedValue({ ...GEO_PROJECT, access: { roles: ["reader"], abilities: ["read"] } });
    renderProject();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("button", { name: "生成周报" })).not.toBeInTheDocument();
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
    expect(screen.getByTestId("actions-tab")).toBeVisible();
    const url = new URL(screen.getByTestId("landed").textContent ?? "", "https://example.test");
    expect(url.searchParams.get("engine")).toBe("deepseek");
    expect(url.searchParams.get("step")).toBe("distribution");
    expect(url.hash).toBe("#geo-budget");
  });

  it.each([["actions#geo-budget", "distribution"], ["visibility#geo-trend", "monitoring"]])(
    "keeps the workbench of %s when a query update removes the anchor", async (address, step) => {
      renderProject(`/app/geo/geo_masi/${address}`);
      // The project's own heading: the loading page has an h1 too, and the rail comes only with the project.
      await screen.findByRole("heading", { level: 1, name: "玛仕度肽注射液" });
      expect(screen.getByRole("heading", { level: 1, name: "玛仕度肽注射液" })).toBeVisible();
      await userEvent.click(screen.getByRole("button", { name: "修改平台筛选" }));
      expect(screen.getByRole("heading", { level: 1, name: "玛仕度肽注射液" })).toBeVisible();
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
      // A quiet poll leaves views read a moment ago alone; data that moves without the project row is read again once it is old.
      await act(async () => { await vi.advanceTimersByTimeAsync(30_001); });
      expect(client.getGeoMonitoring.mock.calls.length).toBe(before);
      await act(async () => { await vi.advanceTimersByTimeAsync(120_001); });
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
  it("keeps every result view reachable through its destination", async () => {
    renderProject("/app/geo/geo_masi/visibility");
    const resultIds: Record<string, string> = { "可见度": "visibility", "准确与安全": "accuracy", "问题与回答": "questions", "信源": "sources", "行动": "actions", "方案": "plan", "依据": "evidence" };
    for (const tab of GEO_TABS.filter((item) => item.key !== "overview")) {
      await chooseResult(tab.label);
      expect(await screen.findByTestId(`${resultIds[tab.label]}-tab`)).toBeInTheDocument();
    }
  });

  it("keeps the answer inside its project with the questions result selected", async () => {
    renderProject("/app/geo/geo_masi/answers/snap_1");
    expect(await screen.findByTestId("answer-page")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "问题与回答" })).toHaveAttribute("aria-selected", "true");
    expect(band()).toHaveClass("sticky");
  });

  it("keeps the selected workflow step and conversation in the result address", async () => {
    renderProject("/app/geo/geo_masi/actions?session=ses_second&step=distribution");
    await chooseResult("准确与安全");
    expect(screen.getByTestId("landed")).toHaveTextContent("/accuracy?session=ses_second");
    expect(screen.getByTestId("landed")).not.toHaveTextContent("step=distribution");
    expect(screen.getByRole("tab", { name: "医学核查" })).toHaveAttribute("aria-selected", "true");
  });

  it("takes workflow steps to their mapped result view and block", async () => {
    renderProject();
    await chooseStep(/^诊断 ·/);
    expect(await screen.findByTestId("accuracy-tab")).toBeInTheDocument();
    expect(screen.getByTestId("landed")).toHaveTextContent("/accuracy?step=diagnosis#geo-errors");
    await chooseStep(/^旅程 ·/);
    expect(screen.getByTestId("landed")).toHaveTextContent("/questions?view=journey");
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
    // The work page has no analytical toolbar.
    await chooseResult("总览");
    await waitFor(() => expect(document.querySelectorAll("[data-toolbar]")).toHaveLength(0));
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
    expect(client.open).toHaveBeenCalledWith({ geoId: "geo_masi", projectId: "p-masi", sessionId: "ses_geo_masi", primarySessionId: "ses_geo_masi" }, expect.stringContaining("补充信尔美还没有覆盖的说明书内容"));

    await chooseResult("信源");
    await waitFor(() => expect(buttons()).toEqual(["分析范围", "选目标档"]));
    await userEvent.click(within(toolbar()).getByRole("button", { name: "选目标档" }));
    const planned = new URL(screen.getByTestId("landed").textContent ?? "", "https://example.test");
    expect(planned.pathname).toBe("/app/geo/geo_masi/plan");
    expect(planned.hash).toBe("#geo-targets");
    expect(planned.searchParams.get("step")).toBe("sources");
    // The project's own conversation is where every open begins; only an addressed one travels in the address.
    expect(planned.searchParams.has("session")).toBe(false);

    // Measured views offer the range, without starting another sampling run.
    await chooseResult("准确与安全");
    await waitFor(() => expect(buttons()).toEqual(["分析范围"]));
    await chooseResult("可见度");
    await waitFor(() => expect(buttons()).toEqual(["分析范围"]));

    // 行动 reads the range too (its analysis of articles and placing), so it says so.
    await chooseResult("行动");
    await waitFor(() => expect(buttons()).toEqual(["分析范围", "让 AI 写下一批稿件"]));
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
    await userEvent.click(await screen.findByText(/任务进度/));
    expect(screen.getByRole("link", { name: "内容" }).closest("li")).toHaveTextContent("进行中");
    expect(screen.getByRole("link", { name: "投放" }).closest("li")).toHaveTextContent("进行中");
  });

  it("opens the answer a 本周 line quotes, whichever tab the server files it under; a line that quotes none lands on its tab", async () => {
    renderProject("/app/geo/geo_masi/overview");
    expect(await screen.findByRole("link", { name: /DeepSeek 仍把用法说成/ })).toHaveAttribute("href", "/app/geo/geo_masi/answers/snap_2");
    expect(screen.getByRole("link", { name: /豆包在“打了减重针恶心/ })).toHaveAttribute("href", "/app/geo/geo_masi/answers/snap_1");
    expect(screen.getByRole("link", { name: /和司美格鲁肽怎么选/ })).toHaveAttribute("href", "/app/geo/geo_masi/sources");
    // 投放 is read on 行动 now, at its own block.
    expect(screen.getByRole("link", { name: /6 篇证据卡片已被百度收录/ })).toHaveAttribute("href", "/app/geo/geo_masi/actions#geo-delivery");
  });

  it("opens each tab with a heading of its own, so the outline never jumps from the title to a third-level block", async () => {
    renderProject("/app/geo/geo_masi/overview");
    await screen.findByRole("heading", { level: 1 });
    const panel = document.querySelector("[data-page-body]") as HTMLElement;
    const headings = [...panel.querySelectorAll("h2, h3")];
    expect(headings[0].tagName).toBe("H2");
    expect(headings[0]).toHaveTextContent("正在写稿");
    await chooseResult("信源");
    await screen.findByTestId("sources-tab");
    expect(panel.querySelector("h2")).toHaveTextContent("信源");
  });

  it("keeps a conversation deep link inside the project shell and native pane", async () => {
    renderProject("/app/geo/geo_masi/chat/ses_geo_masi?step=evidence");
    expect(await screen.findByRole("heading", { name: "玛仕度肽注射液", level: 1 })).toBeInTheDocument();
    expect(screen.getByLabelText("项目对话")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^查看：/ })).not.toBeInTheDocument();
    expect(screen.getByTestId("landed")).toHaveTextContent("step=evidence");
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("marks placing that waits on the reader in the workflow menu", async () => {
    client.getGeoProject.mockResolvedValue({ ...GEO_PROJECT, budget: null });
    renderProject();
    await userEvent.click(await screen.findByText(/任务进度/));
    expect(screen.getByRole("link", { name: "投放" }).closest("li")).toHaveTextContent("等你");
  });

  it("without a media market offers no budget action", async () => {
    client.getGeoProject.mockResolvedValue({ ...GEO_PROJECT, budget: null, market: { configured: false } });
    renderProject();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("button", { name: "设预算" })).not.toBeInTheDocument();
  });

  it("opens analytics from project work without a global rail or bottom composer", async () => {
    renderProject();
    await screen.findByRole("heading", { level: 1, name: "玛仕度肽注射液" });
    expect(document.querySelector("[data-step-rail]")).toBeNull();
    expect(document.querySelector("[data-conversation-bar]")).toBeNull();
    await chooseResult("可见度");
    expect(await screen.findByTestId("visibility-tab")).toBeVisible();
    expect(screen.getByRole("tab", { name: "可见度" })).toHaveAttribute("aria-selected", "true");
  });

  it("offers the native AI entry in the header without a second composer", async () => {
    renderProject("/app/geo/geo_masi/visibility");
    await screen.findByTestId("visibility-tab");
    expect(screen.getAllByRole("button", { name: "询问 AI" })).toHaveLength(1);
    expect(screen.queryAllByRole("button", { name: "让 AI 解读" })).toHaveLength(0);
    expect(screen.queryByRole("textbox", { name: "告诉 AI 接下来要做什么" })).toBeNull();
    expect(document.querySelector("[data-conversation-bar]")).toBeNull();
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
    await waitFor(() => expect(screen.getByTestId("landed")).toHaveTextContent(/^\/app\/geo\/geo_masi$/));
  });

  it("names the three measurement tabs 「AI 回答监测」 in the browser tab, and the others by the project", async () => {
    renderProject("/app/geo/geo_masi/accuracy");
    await screen.findByTestId("accuracy-tab");
    await waitFor(() => expect(document.title).toBe("玛仕度肽注射液 · AI 回答监测 · EviMed Science"));
    await chooseResult("信源");
    await waitFor(() => expect(document.title).toBe("玛仕度肽注射液 · EviMed Science"));
  });

  it("reads the project again, and the tabs' data with it, when a step of the programme changes state", async () => {
    // A step that ends begins: the page reads itself again while it is under way.
    client.getGeoProject.mockResolvedValue({ ...GEO_PROJECT, steps: { ...GEO_PROJECT.steps, diagnosis: { status: "running", requested: true } }, overview: { ...GEO_PROJECT.overview, steps: { ...GEO_PROJECT.overview.steps, diagnosis: { status: "running", requested: true } } } });
    renderProject();
    await screen.findByRole("heading", { level: 1 });
    await userEvent.click(await screen.findByText(/任务进度/));
    expect(screen.getByRole("link", { name: "诊断" }).closest("li")).toHaveTextContent("进行中");
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
    for (const hidden of ["重命名", "生成提案资料包", "暂停", "删除"]) expect(screen.queryByRole("menuitem", { name: hidden })).not.toBeInTheDocument();
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

  it("“打开对话” opens the project's own conversation with nothing in the composer; “生成周报” and the pack start the work and keep the reader where they are", async () => {
    client.exportGeo.mockResolvedValue({ accepted: true, runId: "run_1", step: null });
    renderProject("/app/geo/geo_masi/evidence");
    await userEvent.click(await screen.findByRole("button", { name: "询问 AI" }));
    await waitFor(() => expect(client.open).toHaveBeenCalledWith({ geoId: "geo_masi", projectId: "p-masi", sessionId: "ses_geo_masi", primarySessionId: "ses_geo_masi" }));
    client.open.mockClear();

    await userEvent.click(screen.getByRole("button", { name: "生成周报" }));
    await waitFor(() => expect(client.exportGeo).toHaveBeenCalledWith("geo_masi", "weekly"));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("已开始生成周报。", expect.objectContaining({ action: expect.objectContaining({ label: "查看" }) })));
    // The run is a step of the programme, not a conversation: nothing opens, the reader stays on the page.
    expect(client.open).not.toHaveBeenCalled();
    expect(screen.getByTestId("landed")).toHaveTextContent("/app/geo/geo_masi/evidence");
    // The page read itself again, so a step that began shows on the rail.
    await waitFor(() => expect(client.getGeoProject.mock.calls.length).toBeGreaterThan(1));
  });

  // OPEN-01: the address used to carry the project's own conversation as `?session=`, which made 「对话」 ask for exactly that session, and a
  // kernel that no longer listed it could only refuse. The project's own conversation is the primary open the server repairs.
  it("“打开对话” asks for the project's own conversation as the primary, whatever address the page was reached by, and lands in the session that stands", async () => {
    realOpen.on = true;
    client.nativeOpen.mockResolvedValue({ projectId: "p-masi", sessionId: "ses_replacement", scope: { kind: "geo", geoProjectId: "geo_masi", sessionId: "ses_replacement" } });
    renderProject("/app/geo/geo_masi/evidence?session=ses_geo_masi");
    await userEvent.click(await screen.findByRole("button", { name: "询问 AI" }));
    await waitFor(() => expect(screen.getByTestId("landed")).toHaveTextContent("/app/geo/geo_masi/evidence?session=ses_replacement&conversation=open"));
    // The bar asked for the primary; the pane then proves the session that stands, by name.
    expect(client.nativeOpen).toHaveBeenNthCalledWith(1, "geo_masi", { kind: "primary" });
    expect(client.nativeOpen).not.toHaveBeenCalledWith("geo_masi", { kind: "session", sessionId: "ses_geo_masi" });
  });

  it("“打开对话” still asks by name for a conversation the address names", async () => {
    realOpen.on = true;
    renderProject("/app/geo/geo_masi/evidence?session=ses_second");
    await userEvent.click(await screen.findByRole("button", { name: "询问 AI" }));
    await waitFor(() => expect(screen.getByTestId("landed")).toHaveTextContent("/app/geo/geo_masi/evidence?session=ses_second&conversation=open"));
    expect(client.nativeOpen).toHaveBeenCalledWith("geo_masi", { kind: "session", sessionId: "ses_second" });
  });

  it("a result link preserves the selected session in the address", async () => {
    renderProject("/app/geo/geo_masi/evidence?session=ses_geo_masi");
    await screen.findByTestId("evidence-tab");
    await chooseResult("信源");
    await waitFor(() => expect(screen.getByTestId("landed")).toHaveTextContent("/app/geo/geo_masi/"));
    expect(screen.getByTestId("landed")).toHaveTextContent("session=ses_geo_masi");
  });

  it("an export that waits for the project's run slot says so, and a refusal says why", async () => {
    client.exportGeo.mockResolvedValueOnce({ accepted: true, runId: null, step: null }).mockRejectedValueOnce(new WebApiError("no", { status: 409, code: "geo_project_paused" }));
    renderProject("/app/geo/geo_masi/evidence");
    await userEvent.click(await screen.findByRole("button", { name: "生成周报" }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("周报排在前一项之后，做完会自动开始。", expect.anything()));
    await userEvent.click(await screen.findByRole("button", { name: "生成周报" }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect(client.open).not.toHaveBeenCalled();
  });

  it("a project with no conversation of the person's yet opens a new one", async () => {
    client.getGeoProject.mockResolvedValue({ ...GEO_PROJECT, sessionId: null });
    renderProject("/app/geo/geo_masi/evidence");
    await userEvent.click(await screen.findByRole("button", { name: "询问 AI" }));
    await waitFor(() => expect(client.open).toHaveBeenCalledWith({ geoId: "geo_masi", projectId: "p-masi", sessionId: null, primarySessionId: null }));
  });

  it("“⋯” holds the AI-run record: the steps the programme ran, read where the reader is — and the toast of a start leads to it", async () => {
    client.exportGeo.mockResolvedValue({ accepted: true, runId: "run_1", step: null });
    client.getGeoProgrammeRuns.mockResolvedValue({ runs: [
      { sessionId: "ses_a", label: "写第 1 批稿件", state: "finished", at: "昨天 09:12" },
      { sessionId: "ses_b", label: "整理产品证据、绘制患者旅程、列出测量问题", state: "finished", at: "9月14日" },
    ], nextCursor: null });
    renderProject("/app/geo/geo_masi/evidence");
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
    await userEvent.click(screen.getByRole("button", { name: "生成周报" }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    const action = (toasts.success.mock.calls.at(-1)?.[1] as { action: { onClick: () => void } }).action;
    act(() => action.onClick());
    expect(await screen.findByRole("dialog", { name: "AI 运行" })).toBeInTheDocument();
  });

  it("“⋯” exports the pack without leaving the page, pauses and deletes — deleting only after a confirmation", async () => {
    client.exportGeo.mockResolvedValue({ accepted: true, runId: "run_1", step: null });
    renderProject("/app/geo/geo_masi/evidence");
    await userEvent.click(await screen.findByRole("button", { name: "更多操作" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["重命名", "项目设置", "生成提案资料包", "AI 运行", "暂停", "删除"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "生成提案资料包" }));
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

  it("shows no invented work on a new project and can enter analytics", async () => {
    const steps = Object.fromEntries(Object.keys(GEO_PROJECT.steps).map(step => [step, { status: "none", requested: false, summary: null }]));
    client.getGeoProject.mockResolvedValue({ ...GEO_PROJECT, name: "新循证 GEO 项目", steps, budget: null, sessionId: "ses_new", overview: { metrics: GEO_PROJECT.overview.metrics.map(metric => ({ ...metric, cell: { ...metric.cell, value: null, numerator: null, denominator: null, status: "not_measurable" }, trend: [] })), week: [], steps } });
    client.getGeoDiagnosis.mockResolvedValue({ round: null, rounds: [], byEngine: [], byPool: [], failureModes: {}, errors: [], noise: null, more: [] });
    client.getGeoMonitoring.mockResolvedValue({ series: [], arms: { pilot: [], control: [], netEffect: {} }, byEngine: [], cited: [], newErrors: [], next: null });
    renderProject();
    await screen.findByRole("heading", { level: 1, name: "新循证 GEO 项目" });
    expect(document.querySelector("[data-step-rail]")).toBeNull();
    expect(document.querySelector("[data-conversation-bar]")).toBeNull();
    await userEvent.click(screen.getByText("任务进度"));
    expect(screen.getByText("暂无任务进度。")).toBeVisible();
    expect(screen.queryByRole("button", { name: "生成周报" })).toBeNull();
    await chooseResult("可见度");
    expect(await screen.findByTestId("visibility-tab")).toBeVisible();
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
    await screen.findByRole("heading", { level: 1, name: "玛仕度肽注射液" });
    expect(within(document.querySelector("[data-page-header]") as HTMLElement).getByText("已暂停")).toBeInTheDocument();
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
    renderProject("/app/geo/geo_masi/visibility");
    await waitFor(() => expect(band()).toHaveTextContent("AI 回答测量暂停中（10月20日起）"));
    expect(band()).not.toHaveTextContent(/下次复测|待复测/);
  });

  it("names the engines that are paused while the others are measured, and keeps the next round", async () => {
    client.getGeoMonitoring.mockResolvedValue({ ...monitoringFilled, next: { date: "2099-01-05", kind: "weekly", source:"queued" }, measurement: { state: "measuring", since: null, engines: ["doubao", "kimi"] } });
    renderProject("/app/geo/geo_masi/visibility");
    await waitFor(() => expect(band()).toHaveTextContent("豆包、Kimi 暂停测量"));
    expect(band()).toHaveTextContent("下次复测");
  });

  it("keeps the selected analytics view and the monitoring destination", async () => {
    renderProject("/app/geo/geo_masi/evidence?step=monitoring");
    await screen.findByTestId("evidence-tab");
    await chooseResult("可见度");
    await screen.findByTestId("visibility-tab");
    expect(screen.getByRole("tab", { name: "可见度" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("landed")).not.toHaveTextContent("step=monitoring");
    await chooseStep(/^监测/);
    await waitFor(() => expect(screen.getByTestId("landed")).toHaveTextContent("#geo-trend"));
    expect(screen.getByTestId("visibility-tab")).toBeInTheDocument();
  });
});

describe("the project's conversation for a role that may not converse", () => {
  const viewer = { ...GEO_PROJECT, access: { roles: ["viewer"], abilities: ["read"], owner: false } };
  it("the bar reads the kept conversation as a link, never asks to open one and has nothing to type into", async () => {
    client.getGeoProject.mockResolvedValue(viewer);
    renderProject("/app/geo/geo_masi/visibility");
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("textbox", { name: "告诉 AI 接下来要做什么" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开对话" })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("link", { name: "查看项目对话" }));
    await waitFor(() => { const url = new URL(screen.getByTestId("landed").textContent ?? "", "https://example.test"); expect(url.pathname).toBe("/app/geo/geo_masi/visibility"); expect(url.searchParams.get("conversation")).toBe("open"); expect(url.searchParams.get("session")).toBe("ses_geo_masi"); });
    expect(client.open).not.toHaveBeenCalled();
    expect(client.nativeOpen).not.toHaveBeenCalled();
  });

  it("offers no bar where there is no conversation to read, and the bare conversation address says so instead of loading forever", async () => {
    client.getGeoProject.mockResolvedValue({ ...viewer, sessionId: null });
    renderProject();
    await screen.findByRole("heading", { level: 1 });
    expect(document.querySelector("[data-conversation-bar]")).toBeNull();
    expect(screen.queryByRole("link", { name: "查看项目对话" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开对话" })).not.toBeInTheDocument();
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
    expect(await screen.findByRole("note")).toHaveTextContent("对话暂时无法打开，请稍后重试。");
    expect(client.open).toHaveBeenCalledTimes(1);
    client.open.mockResolvedValue(true);
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(client.open).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("note")).not.toBeInTheDocument());
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
  it("re-reads the shared views on a poll only when a step or the project moved, or when they are old", async () => {
    vi.useFakeTimers();
    const visible = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    try {
      const steps = Object.fromEntries(Object.keys(GEO_PROJECT.steps).map(key => [key, { status: "done" }]));
      const quiet = { ...GEO_PROJECT, steps, overview: { ...GEO_PROJECT.overview, steps } };
      client.getGeoProject.mockResolvedValue(quiet);
      renderProject("/app/geo/geo_masi/actions");
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      const before = client.getGeoMonitoring.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(30_001); });
      expect(client.getGeoProject).toHaveBeenCalledTimes(2);
      expect(client.getGeoMonitoring.mock.calls.length).toBe(before);
      client.getGeoProject.mockResolvedValue({ ...quiet, updatedAt: "2099-01-01T00:00:00.000Z" });
      await act(async () => { await vi.advanceTimersByTimeAsync(30_001); });
      expect(client.getGeoMonitoring.mock.calls.length).toBeGreaterThan(before);
    } finally { visible.mockRestore(); vi.useRealTimers(); }
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


describe("GEO analysis main area", () => {
  it("unmounts the business area and returns with exact originating context", async () => {
    renderProject("/app/geo/geo_masi/questions?view=journey&analysis=V26&strategyVersion=7&targetVersion=3&session=ses_keep&questionVersion=4&selectionRef=gsel_exact");
    expect(await screen.findByTestId("analysis-main")).toHaveTextContent("V26");
    expect(screen.queryByTestId("questions-tab")).toBeNull();
    expect(document.querySelectorAll("[data-toolbar]")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", {name:"返回问题与回答"}));
    expect(await screen.findByTestId("questions-tab")).toBeVisible();
    expect(screen.getByTestId("landed")).toHaveTextContent("view=journey");
    expect(screen.getByTestId("landed")).toHaveTextContent("selectionRef=gsel_exact");
    // The frozen plan version was the analysis's: it is not left in the business address for the next view to inherit.
    expect(screen.getByTestId("landed")).not.toHaveTextContent("strategyVersion");
    expect(screen.getByTestId("landed")).not.toHaveTextContent("targetVersion");
    expect(screen.getByTestId("landed")).not.toHaveTextContent("analysis=");
  });
});


it('merges child business navigation into the parent toolbar without replacing it with analysis navigation',async()=>{
 renderProject('/app/geo/geo_masi/sources');
 expect(await screen.findByRole('button',{name:'sources 的业务视图：当前业务结果'})).toBeVisible();
 expect(screen.getByRole('button',{name:/^深入分析/})).toBeVisible();
 expect(document.querySelectorAll('[data-toolbar]')).toHaveLength(1);
});

it('declares analysis scope separately from its frequent step action and keeps native header icons and menu separation',async()=>{
 renderProject('/app/geo/geo_masi/questions?selectionRef=gsel_keep&questionVersion=2');
 await screen.findByTestId('questions-tab');
 const toolbar=document.querySelector('[data-toolbar]') as HTMLElement;
 expect(toolbar.querySelector('[data-toolbar-scope]')).toHaveTextContent('分析范围 · 已筛选');
 // The step's action is the toolbar's own quiet button beside what it acts on; the page's one primary is the header's next step
 // (DESIGN.md 「页面结构」 rule 3: the fixture walk of df17091ad read a solid 「加问」 at 156 px as a second one).
 const step=within(toolbar).getByRole('button',{name:'让 AI 补充问题'});
 expect(step).toHaveAttribute('data-toolbar-context');
 expect(step).not.toHaveClass('bg-accent');
 expect(toolbar.querySelectorAll('.bg-accent')).toHaveLength(0);
 const header=document.querySelector('[data-page-header]') as HTMLElement;
 // V2 exposes conversation in the header while keeping the contextual step action separate.
 expect(within(header).getByRole('button',{name:'询问 AI'}).querySelector('svg')).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'生成周报'}).querySelector('svg')).toBeInTheDocument();
 await userEvent.click(screen.getByRole('button',{name:'更多操作'}));
 expect(screen.getByRole('menu').querySelector('[role=separator]')).toBeInTheDocument();
 expect(screen.getByRole('menuitem',{name:'删除'})).toBeVisible();
});


describe("choosing an analysis view from the band", () => {
  const pick = async (name: RegExp, option: string) => {
    await userEvent.click(await screen.findByRole("button", { name }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: option }));
  };
  it("leaves the frozen plan version of V26 behind when the person opens the trend, and out of the address they return to", async () => {
    renderProject("/app/geo/geo_masi/questions?view=journey&analysis=V26&strategyVersion=7&targetVersion=3&selectionRef=gsel_exact");
    await screen.findByTestId("analysis-main");
    await chooseResult("可见度");
    await pick(/^深入分析/, "指标趋势");
    await waitFor(() => expect(screen.getByTestId("analysis-main")).toHaveTextContent("V02"));
    const landed = screen.getByTestId("landed");
    expect(landed).toHaveTextContent("analysis=V02");
    expect(landed).toHaveTextContent("dimension=engine");
    expect(landed).not.toHaveTextContent("strategyVersion");
    expect(landed).not.toHaveTextContent("targetVersion");
    expect(landed).toHaveTextContent("selectionRef=gsel_exact");
  });

  it("does not hand the business address's plan version to a view that refuses it", async () => {
    renderProject("/app/geo/geo_masi/plan?step=sources&strategyVersion=7&targetVersion=4");
    await screen.findByTestId("plan-tab");
    await chooseResult("可见度");
    await pick(/^深入分析/, "平台指标比较");
    await waitFor(() => expect(screen.getByTestId("analysis-main")).toHaveTextContent("V04"));
    // Held in the return snapshot for the way back, but not a field of the analysis the server would refuse.
    const query = new URLSearchParams((screen.getByTestId("landed").textContent ?? "").split("?")[1]);
    expect(query.has("strategyVersion")).toBe(false);
    expect(query.get("dimension")).toBe("engine");
    await userEvent.click(screen.getByRole("button", { name: "后退一步" }));
    await userEvent.click(screen.getByRole("button", { name: "后退一步" }));
    await waitFor(() => expect(new URLSearchParams((screen.getByTestId("landed").textContent ?? "").split("?")[1]).get("strategyVersion")).toBe("7"));
  });

  it("drops the source-type filter of V17 and the dimension of V05 when the view changes to one that has neither", async () => {
    renderProject("/app/geo/geo_masi/sources?analysis=V17&sourceType=official&topN=30");
    await screen.findByTestId("analysis-main");
    await chooseResult("可见度");
    await pick(/^深入分析/, "当前水平与目标");
    await waitFor(() => expect(screen.getByTestId("analysis-main")).toHaveTextContent("V01"));
    expect(screen.getByTestId("landed")).not.toHaveTextContent("sourceType");
    expect(screen.getByTestId("landed")).not.toHaveTextContent("topN");
  });

  it("replaces the history entry for a filter inside the open view and adds one for opening it", async () => {
    render(<MemoryRouter initialEntries={["/app/geo/geo_masi/questions", "/app/geo/geo_masi/questions?analysis=V17"]} initialIndex={1}><Routed /></MemoryRouter>);
    await userEvent.click(await screen.findByRole("button", { name: "改分析筛选" }));
    await waitFor(() => expect(screen.getByTestId("landed")).toHaveTextContent("topN=30"));
    await userEvent.click(screen.getByRole("button", { name: "后退一步" }));
    // The filter replaced the entry, so one step back is the business view the analysis was opened from, not the same view unfiltered.
    await waitFor(() => expect(screen.getByTestId("landed")).not.toHaveTextContent("analysis="));
  });
});

describe("the plan's focus on one source", () => {
  it("ends when the person moves to another step, and a later visit to 方案 reads the whole plan", async () => {
    renderProject("/app/geo/geo_masi/plan?step=sources&planSource=src_1&planUrl=https%3A%2F%2Fexample.org%2Fa&selectionRef=gsel_keep");
    await screen.findByTestId("plan-tab");
    expect(screen.getByTestId("landed")).toHaveTextContent("planSource=src_1");
    await chooseStep(/^内容/);
    await waitFor(() => expect(screen.getByTestId("landed")).toHaveTextContent("/actions"));
    expect(screen.getByTestId("landed")).not.toHaveTextContent("planSource");
    expect(screen.getByTestId("landed")).not.toHaveTextContent("planUrl");
    // The analysis range is a separate, named control (分析范围 · 已筛选), and stays.
    expect(screen.getByTestId("landed")).toHaveTextContent("selectionRef=gsel_keep");
    await chooseResult("方案");
    await screen.findByTestId("plan-tab");
    expect(screen.getByTestId("landed")).not.toHaveTextContent("planSource");
  });
});


/** A project with the given steps in the server's shape, otherwise the fixture's. */
function projectWith(steps: Record<string, object>, extra: Record<string, unknown> = {}) {
  return { ...GEO_PROJECT, steps, overview: { ...GEO_PROJECT.overview, steps, week: [] }, ...extra };
}
const header = () => document.querySelector("[data-page-header]") as HTMLElement;
/** The project's own header, not the loading page's, which stands in the same place until the project is read. */
const projectHeader = async () => { await screen.findByRole("heading", { level: 1, name: "玛仕度肽注射液" }); return within(header()); };

describe("the header's one primary is the next step", () => {
  it("leaves the header empty while what is missing is listed on the overview: its way on is a draft that fills the composer, with the pencil", async () => {
    client.getGeoProject.mockResolvedValue(projectWith({}, { product: {}, budget: null }));
    renderProject();
    expect((await projectHeader()).queryByRole("button", { name: "让 AI 确认产品" })).not.toBeInTheDocument();
    const primary = await screen.findByRole("button", { name: "让 AI 确认产品" });
    expect(primary).toHaveAttribute("data-action-kind", "draft");
    expect(primary.querySelector("svg")).not.toBeNull();
    await userEvent.click(primary);
    await waitFor(() => expect(client.open).toHaveBeenCalledWith(expect.objectContaining({ geoId: "geo_masi" }), expect.stringContaining("目标受众")));
    // Nothing is owed yet: money is not asked for first, and there is nothing to report.
    expect(screen.queryByRole("button", { name: "设投放预算" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "生成周报" })).not.toBeInTheDocument();
  });

  it("is a link to the step where there is one to go to, and says nothing where the page already is that step", async () => {
    client.getGeoProject.mockResolvedValue(projectWith({ evidence: { status: "done", requested: false } }, { budget: null }));
    const view = renderProject();
    const link = (await projectHeader()).getByRole("link", { name: "查看问题与下一步" });
    expect(link).toHaveAttribute("href", "/app/geo/geo_masi/questions?view=journey&step=questions".replace("?view=journey&", "?"));
    view.unmount();
    renderProject("/app/geo/geo_masi/questions?step=questions");
    await screen.findByTestId("questions-tab");
    expect(within(header()).queryByRole("link", { name: "查看问题与下一步" })).not.toBeInTheDocument();
  });

  it("is the budget once placing is owed one, and opens the dialog that sets it: money gets its own kind", async () => {
    client.getGeoProject.mockResolvedValue(projectWith({
      evidence: { status: "done", requested: true }, content: { status: "done", requested: true }, distribution: { status: "none", requested: true },
    }, { budget: null }));
    renderProject();
    const primary = (await projectHeader()).getByRole("button", { name: "设投放预算" });
    expect(primary).toHaveAttribute("data-action-kind", "external");
    await userEvent.click(primary);
    expect(await screen.findByRole("dialog", { name: "设置投放预算" })).toBeInTheDocument();
  });

  it("is not the budget for a reader who may not move money, whose next step is the work itself", async () => {
    client.getGeoProject.mockResolvedValue(projectWith({
      evidence: { status: "done", requested: true }, content: { status: "done", requested: true }, distribution: { status: "none", requested: true },
    }, { budget: null, access: { roles: ["editor"], abilities: ["read", "run", "edit"], owner: false } }));
    renderProject();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("button", { name: "设投放预算" })).not.toBeInTheDocument();
    expect((await projectHeader()).getByRole("link", { name: "继续当前工作" })).toBeInTheDocument();
  });

  it("is where the work is going while a step runs, and is not offered to a role that cannot converse when it is a draft", async () => {
    renderProject();
    expect((await projectHeader()).getByRole("link", { name: "继续当前工作" })).toHaveAttribute("href", expect.stringContaining("/actions"));
    client.getGeoProject.mockResolvedValue(projectWith({}, { product: {}, access: { roles: ["viewer"], abilities: ["read"], owner: false } }));
    renderProject();
    await waitFor(() => expect(client.getGeoProject).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("button", { name: "让 AI 确认产品" })).not.toBeInTheDocument());
  });

  it("is nothing but 继续 for a paused project, beside the tag that says it is paused, and generation stays out of the header", async () => {
    client.getGeoProject.mockResolvedValue({ ...GEO_PROJECT, status: "paused" });
    renderProject();
    await screen.findByRole("heading", { level: 1, name: "玛仕度肽注射液" });
    expect(within(header()).getByRole("button", { name: "继续" })).toHaveAttribute("data-action-kind", "set");
    expect(screen.queryByRole("button", { name: "生成周报" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "设投放预算" })).not.toBeInTheDocument();
  });
});

describe("conversation entry", () => {
  it("stages a contextual draft without starting work", async () => {
    renderProject("/app/geo/geo_masi/evidence");
    await userEvent.click(await screen.findByRole("button", { name: "让 AI 补充结论" }));
    expect(client.open).toHaveBeenCalledWith({ geoId: "geo_masi", projectId: "p-masi", sessionId: "ses_geo_masi", primarySessionId: "ses_geo_masi" }, expect.stringContaining("补充信尔美还没有覆盖的说明书内容"));
    expect(client.runGeoStep).not.toHaveBeenCalled();
    expect(client.exportGeo).not.toHaveBeenCalled();
  });
  it("offers one conversation entry on each result and no bottom composer", async () => {
    for (const path of ["/accuracy", "/actions?step=content", "/plan?step=sources", "/evidence"]) {
      const view = renderProject(`/app/geo/geo_masi${path}`);
      await screen.findByRole("heading", { level: 1, name: "玛仕度肽注射液" });
      expect(screen.getByRole("button", { name: "询问 AI" })).toBeVisible();
      expect(document.querySelector("[data-conversation-bar]")).toBeNull();
      view.unmount();
    }
  });
});

describe("the conversation beside the results", () => {
  const widen = (wide: boolean) => vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: wide && query.includes("1180"), media: query, onchange: null,
    addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false,
  }) as unknown as MediaQueryList);

  it("shows the results beside it from 1180 px, with the toolbar of the result, and a press in them leaves the conversation open", async () => {
    const media = widen(true);
    try {
      renderProject("/app/geo/geo_masi/chat/ses_geo_masi?result=sources&step=sources");
      expect(await screen.findByTestId("sources-tab")).toBeInTheDocument();
      expect(document.querySelector("[data-workspace]")).toHaveAttribute("data-workspace", "split");
      expect(screen.getByRole("link", { name: "收起对话" })).toBeInTheDocument();
      // The result keeps its own controls while the conversation is open.
      expect(document.querySelector("[data-toolbar]")).not.toBeNull();
      expect(screen.getByRole("group", { name: "sources 的筛选" })).toBeInTheDocument();
      await chooseResult("准确与安全");
      await waitFor(() => expect(screen.getByTestId("landed")).toHaveTextContent(/^\/app\/geo\/geo_masi\/chat\/ses_geo_masi\?.*result=accuracy/));
      expect(screen.getByTestId("landed")).toHaveTextContent("step=diagnosis");
      expect(await screen.findByTestId("accuracy-tab")).toBeInTheDocument();
      expect(screen.getByTestId("landed")).not.toHaveTextContent(/session=/);
    } finally { media.mockRestore(); }
  });

  it("covers the results with the conversation under 1180 px, which says so and brings them back with 回到结果", async () => {
    renderProject("/app/geo/geo_masi/chat/ses_geo_masi?result=sources&step=sources");
    expect(await screen.findByLabelText("项目对话")).toBeInTheDocument();
    expect(document.querySelector("[data-workspace]")).toHaveAttribute("data-workspace", "cover");
    expect(screen.getByTestId("sources-tab")).not.toBeVisible();
    // What controls the results goes with them.
    expect(screen.queryByRole("group", { name: "sources 的筛选" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "回到结果" }));
    await waitFor(() => expect(screen.getByTestId("landed")).toHaveTextContent(/^\/app\/geo\/geo_masi\/sources/));
    expect(await screen.findByTestId("sources-tab")).toBeInTheDocument();
    expect(screen.getByTestId("landed")).not.toHaveTextContent("/chat/");
  });
});

describe("a step pressed while a finding is open", () => {
  it("clears the finding from the address, so the press moves the content and not only the underline", async () => {
    renderProject("/app/geo/geo_masi/visibility?step=diagnosis&signal=sig_1&signals=open&engines=kimi");
    await screen.findByTestId("visibility-tab");
    expect(screen.getByTestId("landed")).toHaveTextContent("signal=sig_1");
    await userEvent.click(screen.getByRole("tab", { name: "问题与回答" }));
    await waitFor(() => expect(screen.getByTestId("landed")).toHaveTextContent("/questions"));
    const url = new URL(screen.getByTestId("landed").textContent ?? "", "https://example.test");
    expect(url.searchParams.has("signal")).toBe(false);
    expect(url.searchParams.has("signals")).toBe(false);
    // The scope the reader chose is not the finding's: it stays.
    expect(url.searchParams.getAll("engines")).toEqual(["kimi"]);
    expect(await screen.findByTestId("questions-tab")).toBeInTheDocument();
  });
});

describe("what the work waits for from its person, over every view", () => {
  const needing = (needsYou: object[], extra: Record<string, unknown> = {}) => ({ ...GEO_PROJECT, needsYou, ...extra });
  const budgetNeed = { kind: "set_budget", key: "budget", verb: "set", object: { type: "project" }, target: { tab: "actions", section: "budget" } };

  it("is a bar on a result and not on the overview, which lists them itself, and its link goes to where each is done", async () => {
    client.getGeoProject.mockResolvedValue(needing([budgetNeed]));
    renderProject("/app/geo/geo_masi/sources");
    await screen.findByTestId("sources-tab");
    const bar = document.querySelector("[data-work-needs]") as HTMLElement;
    expect(bar).toHaveTextContent("等你 · 待确认");
    expect(bar).toHaveTextContent("设置投放预算");
    expect(within(bar).getByRole("link", { name: "去处理" })).toHaveAttribute("href", expect.stringMatching(/^\/app\/geo\/geo_masi(\?|$)/));
  });

  it("counts the rest, and is gone when nothing waits", async () => {
    client.getGeoProject.mockResolvedValue(needing([budgetNeed, { kind: "step_failed", key: "failed:diagnosis", verb: "retry", object: { type: "step", id: "diagnosis" }, target: { tab: "accuracy" } }]));
    const view = renderProject("/app/geo/geo_masi/sources");
    await screen.findByTestId("sources-tab");
    expect(document.querySelector("[data-work-needs]")).toHaveTextContent("（共 2 项）");
    view.unmount();
    client.getGeoProject.mockResolvedValue(needing([]));
    renderProject("/app/geo/geo_masi/sources");
    await screen.findByTestId("sources-tab");
    expect(document.querySelector("[data-work-needs]")).toBeNull();
  });

  it("asks a reader only for what they can do: money is not asked of someone who cannot move it", async () => {
    client.getGeoProject.mockResolvedValue(needing([budgetNeed], { access: { roles: ["editor"], abilities: ["read", "run", "edit"], owner: false } }));
    renderProject("/app/geo/geo_masi/sources");
    await screen.findByTestId("sources-tab");
    expect(document.querySelector("[data-work-needs]")).toBeNull();
  });
});

describe("running work", () => {
  const running = (extra: Record<string, unknown> = {}) => projectWith({
    evidence: { status: "done", requested: true }, content: { status: "running", requested: true, runId: "run_c", updatedAt: "2026-10-20T08:00:00Z" },
    distribution: { status: "queued", requested: true },
  }, extra);

  it("has a strip on every view that says what is going on and what stands behind it, and stops that one run", async () => {
    client.getGeoProject.mockResolvedValue(running());
    client.stopGeoStepRun.mockResolvedValue({ root: "run_c" });
    renderProject("/app/geo/geo_masi/sources");
    await screen.findByTestId("sources-tab");
    const strip = document.querySelector("[data-activity=strip]") as HTMLElement;
    expect(strip).toHaveTextContent("正在写稿");
    expect(strip).toHaveTextContent("另有 1 项排队");
    expect(within(strip).getByRole("link", { name: "查看进度" })).toHaveAttribute("href", expect.stringContaining("/actions"));
    await userEvent.click(within(strip).getByRole("button", { name: "停止这一项" }));
    await waitFor(() => expect(client.stopGeoStepRun).toHaveBeenCalledWith("geo_masi", "run_c"));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("已停止这一项。已完成的部分保留。"));
  });

  it("gives a reader who cannot run the strip without the stop, and a paused project no strip at all", async () => {
    client.getGeoProject.mockResolvedValue(running({ access: { roles: ["viewer"], abilities: ["read"], owner: false } }));
    const view = renderProject("/app/geo/geo_masi/sources");
    await screen.findByTestId("sources-tab");
    expect(document.querySelector("[data-activity=strip]")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "停止这一项" })).not.toBeInTheDocument();
    view.unmount();
    client.getGeoProject.mockResolvedValue(running({ status: "paused" }));
    renderProject("/app/geo/geo_masi/sources");
    await screen.findByTestId("sources-tab");
    expect(document.querySelector("[data-activity=strip]")).toBeNull();
  });

  it("says a stop that was refused, and keeps the strip", async () => {
    client.getGeoProject.mockResolvedValue(running());
    client.stopGeoStepRun.mockRejectedValue(new WebApiError("no", { status: 409 }));
    renderProject("/app/geo/geo_masi/sources");
    await userEvent.click(await screen.findByRole("button", { name: "停止这一项" }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect(document.querySelector("[data-activity=strip]")).not.toBeNull();
  });

  it("reads the project again at once when a turn of the conversation beside the page ends, and not only on the poll", async () => {
    renderProject("/app/geo/geo_masi/sources");
    await screen.findByTestId("sources-tab");
    const before = client.getGeoProject.mock.calls.length;
    act(() => { window.dispatchEvent(new CustomEvent(CONVERSATION_SETTLED_EVENT, { detail: { sessionId: "ses_geo_masi" } })); });
    await waitFor(() => expect(client.getGeoProject.mock.calls.length).toBeGreaterThan(before));
  });
});

describe("the way back from one answer is the band's", () => {
  it("is the tab that holds the finding for a reader who came from a link, and the page draws no back arrow of its own", async () => {
    renderProject("/app/geo/geo_masi/answers/snap_1?back=accuracy&engines=kimi&session=s1");
    await screen.findByTestId("answer-page");
    const back = within(band().parentElement as HTMLElement).getByRole("link", { name: "返回准确与安全" });
    const href = new URL(back.getAttribute("href")!, "https://example.test");
    expect(href.pathname).toBe("/app/geo/geo_masi/accuracy");
    expect(href.searchParams.getAll("engines")).toEqual(["kimi"]);
    expect(href.searchParams.get("session")).toBe("s1");
    // One way back, not 项目总览 beside it.
    expect(screen.queryByRole("link", { name: "项目总览" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /^返回/ })).toHaveLength(1);
  });

  it("is the questions when the answer holds no finding, as a link to that tab", async () => {
    renderProject("/app/geo/geo_masi/answers/snap_1");
    await screen.findByTestId("answer-page");
    const back = screen.getByRole("link", { name: "返回问题与回答" });
    expect(back).toHaveAttribute("href", "/app/geo/geo_masi/questions");
    await userEvent.click(back);
    await waitFor(() => expect(screen.getByTestId("landed")).toHaveTextContent(/^\/app\/geo\/geo_masi\/questions$/));
  });

  it("is 返回, to the list as the reader left it, when they came from inside the app", async () => {
    renderProject("/app/geo/geo_masi/accuracy?show=open");
    await screen.findByTestId("accuracy-tab");
    await userEvent.click(screen.getByRole("button", { name: "看回答" }));
    await screen.findByTestId("answer-page");
    await userEvent.click(screen.getByRole("link", { name: "返回" }));
    await waitFor(() => expect(screen.getByTestId("landed")).toHaveTextContent("/app/geo/geo_masi/accuracy?show=open"));
    expect(await screen.findByTestId("accuracy-tab")).toBeInTheDocument();
  });
});


describe("V2 conversation continuity", () => {
  it("resolves a bare legacy chat exactly once", async () => {
    realOpen.on = true;
    client.nativeOpen.mockResolvedValue({ projectId: "p-masi", sessionId: "ses_geo_masi", scope: { kind: "geo", geoProjectId: "geo_masi", sessionId: "ses_geo_masi" } });
    renderProject("/app/geo/geo_masi/chat");
    await waitFor(() => expect(screen.getByTestId("landed")).toHaveTextContent("/app/geo/geo_masi/chat/ses_geo_masi"));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(client.nativeOpen.mock.calls.filter(([, target]) => target.kind === "primary")).toHaveLength(1);
  });
  it.each([true, false])("keeps result-local view state after opening and closing AI, wide=%s", async (wide) => {
    const media = vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({ matches: wide && query.includes("1180"), media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false }) as unknown as MediaQueryList);
    try {
      realOpen.on = true;
      client.nativeOpen.mockResolvedValue({ projectId: "p-masi", sessionId: "ses_geo_masi", scope: { kind: "geo", geoProjectId: "geo_masi", sessionId: "ses_geo_masi" } });
      renderProject("/app/geo/geo_masi/visibility");
      const heading = await screen.findByRole("heading", { level: 1, name: "玛仕度肽注射液" });
      expect(heading.closest(".max-w-wide")).not.toBeNull();
      await userEvent.click(await screen.findByRole("button", { name: "visibility 调整视图" }));
      await userEvent.click(screen.getByRole("button", { name: "询问 AI" }));
      await waitFor(() => expect(screen.getByTestId("landed")).toHaveTextContent("conversation=open"));
      expect(heading.closest(".max-w-wide")).not.toBeNull();
      await userEvent.click(await screen.findByRole("link", { name: wide ? "收起对话" : "回到结果" }));
      expect(await screen.findByText("已选择的视图")).toBeVisible();
      expect(screen.getByTestId("landed")).toHaveTextContent("/visibility");
    } finally { media.mockRestore(); }
  });
  it("returns from an answer to the original questions scope after opening and closing AI", async () => {
    realOpen.on = true;
    client.nativeOpen.mockResolvedValue({ projectId: "p-masi", sessionId: "ses_geo_masi", scope: { kind: "geo", geoProjectId: "geo_masi", sessionId: "ses_geo_masi" } });
    renderProject("/app/geo/geo_masi/questions?engine=kimi&view=journey#questions");
    await screen.findByTestId("questions-tab");
    await userEvent.click(screen.getByRole("button", { name: "从问题进入回答" }));
    await screen.findByTestId("answer-page");
    await userEvent.click(screen.getByRole("button", { name: "询问 AI" }));
    await waitFor(() => expect(screen.getByTestId("landed")).toHaveTextContent("conversation=open"));
    await userEvent.click(await screen.findByRole("link", { name: "回到结果" }));
    await userEvent.click(await screen.findByRole("link", { name: "返回" }));
    await waitFor(() => {
      const url = new URL(screen.getByTestId("landed").textContent ?? "", "https://example.test");
      expect(url.pathname).toBe("/app/geo/geo_masi/questions");
      expect(url.searchParams.getAll("engine").concat(url.searchParams.getAll("engines"))).toEqual(["kimi"]);
      expect(url.searchParams.get("view")).toBe("journey");
      expect(url.hash).toBe("#questions");
    });
  });
});


it("keeps an analysis descriptor when closing legacy chat on a narrow screen", async () => {
  const media = vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({ matches: false, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false }) as unknown as MediaQueryList);
  try {
    renderProject("/app/geo/geo_masi/chat/ses_geo_masi?result=visibility&analysis=V02&dimension=engine&selectionRef=gsel_exact#trend");
    await userEvent.click(await screen.findByRole("link", { name: "回到结果" }));
    await waitFor(() => {
      const url = new URL(screen.getByTestId("landed").textContent ?? "", "https://example.test");
      expect(url.pathname).toBe("/app/geo/geo_masi/visibility");
      expect(url.searchParams.get("analysis")).toBe("V02");
      expect(url.searchParams.get("dimension")).toBe("engine");
      expect(url.searchParams.get("selectionRef")).toBe("gsel_exact");
      expect(url.hash).toBe("#trend");
    });
  } finally { media.mockRestore(); }
});


it("lets a read-only member open and close an answer conversation then return to questions", async () => {
  client.getGeoProject.mockResolvedValue({ ...GEO_PROJECT, access: { roles: ["viewer"], abilities: ["read"], owner: false } });
  renderProject("/app/geo/geo_masi/questions?engine=kimi&view=journey#questions");
  await screen.findByTestId("questions-tab");
  await userEvent.click(screen.getByRole("button", { name: "从问题进入回答" }));
  await screen.findByTestId("answer-page");
  await userEvent.click(screen.getByRole("link", { name: "查看项目对话" }));
  await waitFor(() => expect(screen.getByTestId("landed")).toHaveTextContent("conversation=open"));
  await userEvent.click(await screen.findByRole("link", { name: "回到结果" }));
  await userEvent.click(await screen.findByRole("link", { name: "返回" }));
  await waitFor(() => {
    const url = new URL(screen.getByTestId("landed").textContent ?? "", "https://example.test");
    expect(url.pathname).toBe("/app/geo/geo_masi/questions");
    expect(url.searchParams.getAll("engine").concat(url.searchParams.getAll("engines"))).toEqual(["kimi"]);
    expect(url.searchParams.get("view")).toBe("journey");
    expect(url.hash).toBe("#questions");
  });
  expect(client.open).not.toHaveBeenCalled();
  expect(client.nativeOpen).not.toHaveBeenCalled();
});


it("preserves a pending AI draft when applying the analysis scope and replacing a filter", async () => {
  const media = vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query.includes("1180"), media: query, onchange: null,
    addListener: () => undefined, removeListener: () => undefined,
    addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false,
  }));
  try {
    const pending = prepareRuntimeUiIntent({ kind: "open", projectId: GEO_PROJECT.projectId, sessionId: "pending-session", requestId: "pending-scope", draft: "Keep pending scope draft", owner: sessionOwner() });
    const state = { runtimeUiIntent: pending, extra: "kept" };
    render(<MemoryRouter initialEntries={[
      { pathname: "/app/geo/geo_masi/questions", search: "?conversation=open&session=pending-session", state },
      { pathname: "/app/geo/geo_masi/questions", search: "?analysis=V17&conversation=open&session=pending-session", state },
    ]} initialIndex={1}><Routed /></MemoryRouter>);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "分析范围" }));
    const scope = screen.getByRole("dialog", { name: "分析范围" });
    await user.click(within(scope).getByRole("button", { name: "Kimi" }));
    await user.click(within(scope).getByRole("button", { name: "应用范围" }));
    await waitFor(() => expect(screen.getByTestId("landed")).toHaveTextContent("engines=kimi"));
    expect(JSON.parse(screen.getByLabelText("Project navigation state").textContent ?? "{}")).toEqual(state);
    await user.click(await screen.findByRole("button", { name: "改分析筛选" }));
    await waitFor(() => expect(screen.getByTestId("landed")).toHaveTextContent("topN=30"));
    expect(screen.getByTestId("landed")).toHaveTextContent("session=pending-session");
    expect(JSON.parse(screen.getByLabelText("Project navigation state").textContent ?? "{}")).toEqual(state);
    await user.click(screen.getByRole("button", { name: "后退一步" }));
    await waitFor(() => expect(screen.getByTestId("landed")).not.toHaveTextContent("analysis="));
    expect(JSON.parse(screen.getByLabelText("Project navigation state").textContent ?? "{}")).toEqual(state);
  } finally { media.mockRestore(); }
});
