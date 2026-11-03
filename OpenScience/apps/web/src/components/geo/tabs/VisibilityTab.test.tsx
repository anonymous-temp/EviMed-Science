import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GeoEngine, GeoProject } from "@/lib/geoClient";
import { GEO_PROJECT } from "../__fixtures__/geoProjects";
import { cell, diagnosisFilled, diagnosisWith, geoProject, monitoringFilled, strategyFilled } from "../__fixtures__/geoTabs";
import { clustersFilled, clusterViewFixture, G_BRAND, G_CONTROL, G_EFFECT, G_SAFETY } from "../__fixtures__/geoSpine";
import { GeoFrameHarness } from "../__fixtures__/geoFrameHarness";
import { VisibilityTab } from "./VisibilityTab";

const client = vi.hoisted(() => ({
  getGeoDiagnosis: vi.fn(),
  getGeoMonitoring: vi.fn(),
  getGeoStrategy: vi.fn(),
  getGeoClusters: vi.fn(),
  getGeoCluster: vi.fn(),
  getGeoQuestions: vi.fn(),
  runGeoStep: vi.fn(),
}));
vi.mock("@/lib/geoClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/geoClient")>()),
  ...client,
}));

function Probe() {
  const location = useLocation();
  return <div data-testid="search">{location.search}</div>;
}

function renderTab(project: GeoProject = geoProject(), path = "/app/geo/geo_1/visibility") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/app/geo/geo_1/visibility"
          element={<><GeoFrameHarness project={project} tab="visibility"><VisibilityTab geoId="geo_1" project={project} /></GeoFrameHarness><Probe /></>}
        />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

// The three engines the groups were asked on, and the same three the engine grid has rows for.
const withEngines = {
  ...diagnosisFilled,
  byEngine: ["doubao", "qianwen", "deepseek"].map((engine, index) => ({
    engine: engine as GeoEngine,
    mention: cell(30 + index, 10 + index, 40),
    accuracy: cell(90 + index, 36 + index, 40),
    citation: cell(10 + index, 4, 40),
    retrieval: cell(80, 32, 40),
  })),
};
const monitoring = {
  ...monitoringFilled,
  series: [
    ...monitoringFilled.series,
    { key: "accuracy", points: [{ date: "2026-09-22", value: 90, n: 100, k: 90 }, { date: "2026-10-13", value: 94, n: 100, k: 94 }] },
  ],
};

beforeEach(() => {
  for (const fn of Object.values(client)) fn.mockReset();
  client.getGeoDiagnosis.mockResolvedValue(withEngines);
  client.getGeoMonitoring.mockResolvedValue(monitoring);
  client.getGeoStrategy.mockResolvedValue(strategyFilled);
  client.getGeoClusters.mockResolvedValue(clustersFilled);
  client.getGeoQuestions.mockResolvedValue({ sets: [], groups: clustersFilled.groups, version: 1 });
  client.getGeoCluster.mockImplementation(async (_geoId: string, id: string) => clusterViewFixture(id));
  client.runGeoStep.mockResolvedValue({ sessionId: "ses_geo_1" });
});

const groupRow = (id: string) => document.querySelector(`[data-cluster-row='${id}']`) as HTMLElement | null;
const toolbar = () => document.querySelector("[data-toolbar]") as HTMLElement;

describe("可见度: the order of what it shows", () => {
  it("retains the original baseline and target alongside the current reading", async () => {
    const project = geoProject();
    renderTab({ ...project, overview: { ...project.overview, metrics: project.overview.metrics.map((metric) => metric.key === "gvi" ? { ...metric, trend: [{ date: "2026-09-25", value: 31 }, { date: "2026-10-12", value: 38 }] } : metric) } });
    const band = await screen.findByRole("group", { name: "综合可见度指数" });
    await waitFor(() => expect(band).toHaveTextContent("基线 31"));
    expect(band).toHaveTextContent("目标 55");
    expect(band).toHaveTextContent("38");
  });
  it("does not present unjudged answers as zero serious errors in the relocated metrics", async () => {
    const zero = { ...withEngines.failureModes.correct, status: "ok" as const, numerator: 0, denominator: 40, value: 0 };
    client.getGeoDiagnosis.mockResolvedValue({ ...withEngines, errorCounts: { ...withEngines.errorCounts!, severe: 0 }, failureModes: { ...withEngines.failureModes, correct: zero, wrongOurs: zero, unknown: { ...zero, numerator: 40, value: 100 } } });
    renderTab();
    const safety = await screen.findByRole("group", { name: "用药安全" });
    expect(safety).toHaveTextContent("核查不足");
    expect(safety).not.toHaveTextContent("0条严重讲错");
  });
  it("retains platform, pool and group choices after the measured rows have been narrowed", async () => {
    const group = clustersFilled.groups.find(row => row.id === G_EFFECT)!;
    client.getGeoClusters.mockResolvedValue({ ...clustersFilled, engines: ["deepseek"], groups: [group] });
    client.getGeoDiagnosis.mockResolvedValue({ ...withEngines, byEngine: withEngines.byEngine.filter(row => row.engine === "deepseek") });
    renderTab(geoProject(), `/app/geo/geo_1/visibility?engine=deepseek&pool=${group.pool}&cluster=${group.id}`);
    await screen.findByRole("heading", { name: /综合可见度指数/ });
    await userEvent.click(within(toolbar()).getByRole("button", { name: /^筛选/ }));
    expect(await screen.findByRole("button", { name: "豆包" })).toBeVisible();
    expect(screen.getByRole("group", { name: "问句池" })).toBeVisible();
    expect(screen.getByRole("group", { name: "问题群" })).toBeVisible();
  });
  it("keeps the risk rate in ordinary sentence flow with its sample, direction and answer link", async () => {
    client.getGeoDiagnosis.mockResolvedValue({ ...withEngines, more: [...withEngines.more, { metricId: "M-15", name: "风险问句被推荐率", cell: cell(30, 36, 120, { snapshotIds: ["risk_answer"] }) }] });
    renderTab();
    const line = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-geo-risk-line]");
      expect(found).not.toBeNull();
      return found!;
    });
    const link = within(line).getByRole("link", { name: /风险问句被推荐率，看回答/ });
    expect(link).toHaveAttribute("href", "/app/geo/geo_1/answers/risk_answer");
    expect(link).toHaveTextContent("30%120 次里 36 次");
    expect(line).toHaveTextContent("（越低越好）");
    expect(line).not.toHaveClass("inline-flex");
    expect(line).not.toHaveClass("flex");
    expect(document.querySelector("[data-geo-pool='P4']")).toBeNull();
    await userEvent.click(link);
    expect(screen.queryByRole("table", { name: "按问句池的品牌提及率" })).toBeNull();
  });
  it("is the trend, then the engines against the rates, then the groups against the engines, the pools, the rivals", async () => {
    renderTab();
    await screen.findByRole("heading", { name: /综合可见度指数/ });
    await waitFor(() => expect(document.querySelector("[data-cluster-grid]")).not.toBeNull());
    const blocks = ["[data-chart='trend']", "[data-heat-row]", "[data-geo-engine-trend]", "[data-cluster-grid]", "[data-geo-pool]"].map((selector) => document.querySelector(selector) as HTMLElement);
    for (const block of blocks) expect(block, "a block is missing").not.toBeNull();
    for (let at = 1; at < blocks.length; at += 1) {
      expect(blocks[at - 1].compareDocumentPosition(blocks[at]) & Node.DOCUMENT_POSITION_FOLLOWING, `block ${at} follows block ${at - 1}`).toBeTruthy();
    }
    expect(screen.getByText("更多指标").closest("details")).toBeTruthy();
  });

  it("holds the engine grid that 总览 no longer has: every engine, the rates it was measured on", async () => {
    renderTab();
    await screen.findByRole("heading", { name: /综合可见度指数/ });
    const grid = await screen.findByRole("table", { name: "各引擎的提及、准确与引用" });
    expect(within(grid).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(expect.arrayContaining(["品牌提及率", "事实准确率"]));
    expect(document.querySelectorAll("[data-heat-row]").length).toBeGreaterThanOrEqual(3);
  });
});

describe("可见度: the groups against the engines", () => {
  it("counts: every cell is answers that named us over answers, and not one carries a percentage", async () => {
    renderTab();
    const grid = await waitFor(() => {
      const found = document.querySelector("[data-cluster-grid]") as HTMLElement | null;
      if (!found) throw new Error("not yet");
      return found;
    });
    const brand = grid.querySelector(`[data-cluster-row='${G_BRAND}']`) as HTMLElement;
    expect(within(brand).getAllByRole("button").map((button) => button.textContent)).toEqual(["4/4", "4/4", "3/4"]);
    expect(grid.textContent).not.toMatch(/%/);
    // three states and a hatched one, said in the legend
    expect(grid).toHaveTextContent("每个回答都提到了");
    expect(grid).toHaveTextContent("都没有提到");
    expect(grid).toHaveTextContent("没有测");
    // the conclusion is the count a reader would otherwise do by hand
    expect(screen.getByRole("heading", { name: /个问题群里，\d+ 个在所有引擎里都没有被提到/ })).toBeInTheDocument();
  });

  it("marks a control group as one, and a group's name is a link to its drawer", async () => {
    renderTab();
    await waitFor(() => expect(groupRow(G_CONTROL)).not.toBeNull());
    expect(groupRow(G_CONTROL)).toHaveTextContent("对照");
    const name = within(groupRow(G_BRAND)!).getByRole("link", { name: "品牌身份、规格与厂家" });
    expect(name).toHaveAttribute("data-geo-cluster-link", G_BRAND);
    expect(name.getAttribute("href")).toContain(`group=${G_BRAND}`);
    // At its cells' 28 px, as they open the same drawer: one look for one job (a 12 px inline link was a kind of control of its own).
    expect(name).toHaveClass("block", "h-sm", "truncate");
    expect(within(groupRow(G_BRAND)!).getAllByRole("button")[0]).toHaveClass("h-sm");
  });

  it("opens the group's drawer resting on the engine of the cell, and leaves the page's own engine choice alone", async () => {
    renderTab();
    await waitFor(() => expect(groupRow(G_SAFETY)).not.toBeNull());
    const cellButton = within(groupRow(G_SAFETY)!).getAllByRole("button")[1];
    await userEvent.click(cellButton);
    await waitFor(() => expect(screen.getByTestId("search")).toHaveTextContent(`group=${G_SAFETY}`));
    expect(screen.getByTestId("search")).toHaveTextContent("on=qianwen");
    expect(screen.getByTestId("search")).not.toHaveTextContent("engine=");
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});

describe("可见度: the band's toolbar drives every block", () => {
  it("holds the metric, the engine, the pool and the group; nothing filters from under a block", async () => {
    renderTab();
    await screen.findByRole("heading", { name: /综合可见度指数/ });
    await waitFor(() => expect(document.querySelector("[data-cluster-grid]")).not.toBeNull());
    expect(within(toolbar()).getByRole("button", { name: /^指标：/ })).toBeVisible();
    expect(screen.queryByRole("group", { name: "引擎" })).toBeNull();
    await userEvent.click(within(toolbar()).getByRole("button", { name: /^筛选/ }));
    for (const name of ["引擎", "问句池", "问题群"]) expect(screen.getByRole("group", { name })).toBeVisible();
  });

  it("a metric chip moves the trend, rings the grid's column and swaps the engines' card for that rate's bars", async () => {
    renderTab();
    await screen.findByRole("heading", { name: /综合可见度指数/ });
    // the index has no column of its own: nothing is ringed, and the engines' card is the mention trend
    expect(document.querySelector("th[data-heat-emphasis]")).toBeNull();
    expect(document.querySelector("[data-geo-engine-trend]")).not.toBeNull();
    await userEvent.click(within(toolbar()).getByRole("button", { name: /^指标：/ }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "事实准确率" }));
    await screen.findByRole("heading", { name: /^事实准确率 94%/ });
    expect(document.querySelector("th[data-heat-emphasis]")).toHaveTextContent("事实准确率");
    expect(document.querySelector("[data-geo-engine-trend]")).toBeNull();
    const bars = await screen.findByRole("list", { name: "各引擎的事实准确率" });
    expect(within(bars).getAllByRole("button")).toHaveLength(3);
  });

  it("an engine narrows the grid, the groups' columns and the engines' card to it, and the bars of the card are the same choice", async () => {
    renderTab();
    await screen.findByRole("heading", { name: /综合可见度指数/ });
    await waitFor(() => expect(document.querySelector("[data-cluster-grid]")).not.toBeNull());
    await userEvent.click(within(toolbar()).getByRole("button", { name: /^筛选/ }));
    await userEvent.click(await screen.findByRole("button", { name: "千问" }));
    expect(screen.getByTestId("search")).toHaveTextContent("engine=qianwen");
    // the groups are read on that engine alone
    const brand = groupRow(G_BRAND)!;
    expect(within(brand).getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: /在千问里都没有被提到/ })).toBeInTheDocument();
    // the engine of the grid is the bold row
    expect(document.querySelector("th[data-heat-emphasis]")).toHaveTextContent("千问");
  });

  it("a pool narrows the groups to it and the pool table to its row; the group choice offers only what the pool holds", async () => {
    renderTab();
    await waitFor(() => expect(groupRow(G_BRAND)).not.toBeNull());
    await userEvent.click(within(toolbar()).getByRole("button", { name: /^筛选/ }));
    await userEvent.click(await screen.findByRole("button", { name: "增量" }));
    expect(screen.getByTestId("search")).toHaveTextContent("pool=P2");
    expect(groupRow(G_BRAND)).toBeNull();
    expect(groupRow(G_EFFECT)).not.toBeNull();
    expect(groupRow(G_CONTROL)).not.toBeNull();
    expect(groupRow(G_SAFETY)).toBeNull();
    expect(document.querySelectorAll("[data-geo-pool]")).toHaveLength(1);
    const offered = within(screen.getByRole("group", { name: "问题群" })).getAllByRole("button").map(item => item.textContent);
    expect(offered).toEqual(expect.arrayContaining(["效果怎么样、要打多久", "对照一"]));
    expect(offered).not.toContain("说明书安全题组");
  });

  it("one group alone, and the choices let go together", async () => {
    renderTab(geoProject(), `/app/geo/geo_1/visibility?cluster=${G_EFFECT}`);
    await waitFor(() => expect(groupRow(G_EFFECT)).not.toBeNull());
    expect(groupRow(G_BRAND)).toBeNull();
    await userEvent.click(within(toolbar()).getByRole("button", { name: "清除筛选" }));
    expect(screen.getByTestId("search")).not.toHaveTextContent("cluster=");
    expect(groupRow(G_BRAND)).not.toBeNull();
  });
});

describe("可见度: what is not measured is said, not drawn", () => {
  it("draws no matrix where no group was asked, and says nothing of one", async () => {
    client.getGeoClusters.mockResolvedValue({ ...clustersFilled, groups: [] });
    renderTab();
    await screen.findByRole("heading", { name: /综合可见度指数/ });
    expect(document.querySelector("[data-cluster-grid]")).toBeNull();
  });
});


it("keeps monitoring settings reachable while data is loading and shows the true configured status", async () => {
  client.getGeoMonitoring.mockReturnValue(new Promise(() => undefined));
  client.getGeoDiagnosis.mockReturnValue(new Promise(() => undefined));
  const project = geoProject();
  project.steps.monitoring = { status: "running", requested: true, automation: { state: "confirmed", actorId: "a", at: "2026-10-01T00:00:00Z", engines: [...project.engines], coverageDays: project.coverageDays } };
  const openPanel = vi.fn();
  render(<MemoryRouter initialEntries={["/app/geo/geo_1/visibility"]}><GeoFrameHarness project={project} tab="visibility" openPanel={openPanel}><VisibilityTab geoId="geo_1" project={project} /></GeoFrameHarness></MemoryRouter>);
  expect(screen.getByText("已开启自动监测")).toBeVisible();
  await userEvent.click(screen.getByRole("link", { name: "监测设置" }));
  expect(openPanel).toHaveBeenCalledWith("settings");
  expect(screen.queryByRole("button", { name: "停止自动监测" })).toBeNull();
});

it("places the existing trend and same-scope ranking in one responsive area", async () => {
  renderTab();
  const ranking = await screen.findByRole("table", { name: "同类药提及率" });
  const area = document.querySelector("[data-geo-trend-ranking]")!;
  expect(area).toHaveClass("grid", "lg:grid-cols-2");
  expect(area).toContainElement(ranking);
  expect(area.querySelector("[data-chart='trend']")).not.toBeNull();
});

it("opens settings from the automation anchor even when both reads fail", async () => {
  client.getGeoMonitoring.mockRejectedValue(new Error("unavailable"));
  client.getGeoDiagnosis.mockRejectedValue(new Error("unavailable"));
  const project = geoProject();
  const openPanel = vi.fn();
  render(<MemoryRouter initialEntries={["/app/geo/geo_1/visibility#geo-automation"]}><GeoFrameHarness project={project} tab="visibility" openPanel={openPanel}><VisibilityTab geoId="geo_1" project={project} /></GeoFrameHarness></MemoryRouter>);
  await waitFor(() => expect(openPanel).toHaveBeenCalledWith("settings"));
  await screen.findByRole("button", { name: /重试/ });
  expect(screen.getByRole("link", { name: "监测设置" })).toBeVisible();
});


it("opens the monitoring deep link once per hash visit and still allows explicit reopening", async () => {
  const project = geoProject();
  const openPanel = vi.fn();
  render(<MemoryRouter initialEntries={["/app/geo/geo_1/visibility#geo-automation"]}>
    <Link to="?metric=mention#geo-automation">Change metric</Link>
    <Link to="?metric=mention">Leave automation link</Link>
    <Link to="?metric=mention#geo-automation">Reenter automation link</Link>
    <GeoFrameHarness project={project} tab="visibility" openPanel={openPanel}><VisibilityTab geoId="geo_1" project={project} /></GeoFrameHarness>
  </MemoryRouter>);
  expect(openPanel).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("link", { name: "Change metric" }));
  expect(openPanel).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("link", { name: "监测设置" }));
  expect(openPanel).toHaveBeenCalledTimes(2);
  await userEvent.click(screen.getByRole("link", { name: "Leave automation link" }));
  expect(openPanel).toHaveBeenCalledTimes(2);
  await userEvent.click(screen.getByRole("link", { name: "Reenter automation link" }));
  expect(openPanel).toHaveBeenCalledTimes(3);
});


it("preserves measured metrics, comparison, denominator and insufficient sample on visibility", async () => {
  const severe = diagnosisWith([{ ...diagnosisFilled.errors[0], severity: "S3", status: "open" }]);
  client.getGeoDiagnosis.mockResolvedValue(severe);
  renderTab(GEO_PROJECT);
  const gvi = await screen.findByRole("group", { name: "综合可见度指数" });
  await waitFor(() => expect(gvi).toHaveTextContent("38"));
  expect(gvi).toHaveTextContent("目标 55");
  expect(gvi).toHaveTextContent("提及率第 2 / 2");
  expect(gvi).toHaveTextContent("司美格鲁肽 提及率 48%");
  const mention = screen.getByRole("group", { name: "品类问题可见率" });
  expect(mention).toHaveTextContent("18");
  expect(mention).toHaveTextContent("目标 35%");
  const citation = screen.getByRole("group", { name: "引用命中率" });
  expect(citation).toHaveTextContent("样本不足");
  expect(citation).not.toHaveTextContent("6%");
  expect(screen.getByRole("group", { name: "用药安全" })).toHaveTextContent("1");
  const stats = screen.getByRole("region", { name: "本轮指标" });
  expect(within(stats).getAllByText(/按 3 个引擎、310 次有效回答计算/)).toHaveLength(1);
});

it("does not show unmeasured project metrics as measured zero", async () => {
  const project = geoProject();
  const metrics = project.overview.metrics.map(metric => ({ ...metric, cell: { ...metric.cell, value: null, numerator: null, denominator: null, status: "not_measurable" as const }, trend: [] }));
  client.getGeoDiagnosis.mockResolvedValue({ ...diagnosisFilled, round: null, errors: [], errorCounts: undefined, failureModes: {}, byEngine: [], byPool: [], more: [] });
  client.getGeoMonitoring.mockResolvedValue({ ...monitoringFilled, series: [], byEngine: [], next: null });
  renderTab({ ...project, overview: { ...project.overview, metrics } });
  const stats = await screen.findByRole("region", { name: "本轮指标" });
  await waitFor(() => expect(within(stats).getByRole("group", { name: "综合可见度指数" })).toHaveTextContent(/未测|—/));
  for (const label of ["综合可见度指数", "品类问题可见率", "引用命中率"]) {
    const tile = within(stats).getByRole("group", { name: label });
    expect(tile.querySelector("[data-stat-value]")).not.toHaveTextContent(/^0(?:%|条|$)/);
  }
  expect(within(stats).getByRole("group", { name: "用药安全" })).not.toHaveTextContent("0条严重讲错");
  expect(stats).not.toHaveTextContent(/次有效回答计算/);
});
