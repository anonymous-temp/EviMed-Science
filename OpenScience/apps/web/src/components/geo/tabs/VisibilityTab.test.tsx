import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GeoProject } from "@/lib/geoClient";
import { cell, diagnosisFilled, geoProject, monitoringFilled } from "../__fixtures__/geoTabs";
import { clustersFilled, clusterViewFixture, G_BRAND, G_CONTROL, G_EFFECT, G_SAFETY } from "../__fixtures__/geoSpine";
import { GeoFrameHarness } from "../__fixtures__/geoFrameHarness";
import { VisibilityTab } from "./VisibilityTab";

const client = vi.hoisted(() => ({
  getGeoDiagnosis: vi.fn(),
  getGeoMonitoring: vi.fn(),
  getGeoClusters: vi.fn(),
  getGeoCluster: vi.fn(),
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
    engine: engine as "doubao",
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
  client.getGeoClusters.mockResolvedValue(clustersFilled);
  client.getGeoCluster.mockImplementation(async (_geoId: string, id: string) => clusterViewFixture(id));
  client.runGeoStep.mockResolvedValue({ sessionId: "ses_geo_1" });
});

const groupRow = (id: string) => document.querySelector(`[data-cluster-row='${id}']`) as HTMLElement | null;
const toolbar = () => document.querySelector("[data-toolbar]") as HTMLElement;

describe("可见度: the order of what it shows", () => {
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
    expect(document.querySelector("details")?.textContent).toContain("更多指标");
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
    expect(within(toolbar()).getByRole("group", { name: "指标" })).toBeInTheDocument();
    expect(within(toolbar()).getByRole("button", { name: "引擎" })).toBeInTheDocument();
    expect(within(toolbar()).getByRole("button", { name: "问句池" })).toBeInTheDocument();
    expect(within(toolbar()).getByRole("button", { name: "问题群" })).toBeInTheDocument();
    for (const group of document.querySelectorAll("[role='group'][aria-label]")) {
      if (["各引擎的提及、准确与引用"].includes(group.getAttribute("aria-label") ?? "")) continue;
      expect(toolbar().contains(group) || group.closest("[data-toolbar]") !== null || group.getAttribute("aria-label") === "指标", group.getAttribute("aria-label") ?? "").toBe(true);
    }
    for (const search of document.querySelectorAll("input[type='search']")) expect(toolbar().contains(search)).toBe(true);
  });

  it("a metric chip moves the trend, rings the grid's column and swaps the engines' card for that rate's bars", async () => {
    renderTab();
    await screen.findByRole("heading", { name: /综合可见度指数/ });
    // the index has no column of its own: nothing is ringed, and the engines' card is the mention trend
    expect(document.querySelector("th[data-heat-emphasis]")).toBeNull();
    expect(document.querySelector("[data-geo-engine-trend]")).not.toBeNull();
    await userEvent.click(within(toolbar()).getByRole("button", { name: "事实准确率" }));
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
    await userEvent.click(within(toolbar()).getByRole("button", { name: "引擎" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "千问" }));
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
    await userEvent.click(within(toolbar()).getByRole("button", { name: "问句池" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "增量" }));
    expect(screen.getByTestId("search")).toHaveTextContent("pool=P2");
    expect(groupRow(G_BRAND)).toBeNull();
    expect(groupRow(G_EFFECT)).not.toBeNull();
    expect(groupRow(G_CONTROL)).not.toBeNull();
    expect(groupRow(G_SAFETY)).toBeNull();
    expect(document.querySelectorAll("[data-geo-pool]")).toHaveLength(1);
    await userEvent.click(within(toolbar()).getByRole("button", { name: "问题群" }));
    const offered = (await screen.findAllByRole("menuitemradio")).map((item) => item.textContent);
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
