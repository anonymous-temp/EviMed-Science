import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GeoAction, GeoActionSource, GeoProject, GeoSourceRow } from "@/lib/geoClient";
import { geoProject, sourceDetailOf, sourcesFilled } from "../__fixtures__/geoTabs";
import { actionFixture, actionsFilled, clustersFilled, clusterViewFixture, G_BRAND, G_EFFECT, G_SAFETY } from "../__fixtures__/geoSpine";
import { GeoFrameHarness } from "../__fixtures__/geoFrameHarness";
import { SourcesTab } from "./SourcesTab";

const client = vi.hoisted(() => ({
  getGeoSources: vi.fn(),
  getGeoSource: vi.fn(),
  getGeoActions: vi.fn(),
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

function renderTab(project: GeoProject = geoProject(), path = "/app/geo/geo_1/sources") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/app/geo/geo_1/sources"
          element={<><GeoFrameHarness project={project} tab="sources"><SourcesTab geoId="geo_1" project={project} /></GeoFrameHarness><Probe /></>}
        />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

const site = (overrides: Partial<GeoActionSource> & Pick<GeoActionSource, "domain">): GeoActionSource => ({
  channel: null, name: null, kind: null, layer: null, why: null, citedFor: {}, conditions: {}, price: null, available: null,
  unavailableBecause: [], route: "waiting_market", origin: "cited", chosen: "recommended", orderId: null, articleIds: [], ...overrides,
});

/** Two actions send articles to sites on this page: one for the effect group, one for the safety group; one site is both's. */
const effect: GeoAction = actionFixture({
  key: "fill_gap:ggr_effect:a",
  kind: "fill_gap",
  group: { id: G_EFFECT, name: "P2-04 效果怎么样、要打多久", pool: "P2", journeyStage: "疗效评估", journeyStageNo: 2, weight: 0.08, isControl: false },
  sources: [
    site({ domain: "dxy.com", name: "丁香医生", kind: "health_media", layer: "coverage", citedFor: { doubao: 30 }, conditions: { icp: true, newsIndexed: true, medical: true }, why: "医疗垂直站" }),
    site({ domain: null, channel: "wechat_mp", name: "微信公众号", layer: "owned", route: "own", available: true, origin: "own_channel" }),
  ],
});
const safety: GeoAction = actionFixture({
  key: "fill_gap:ggr_safety:a",
  kind: "fill_gap",
  group: { id: G_SAFETY, name: "P4-04 说明书安全题组", pool: "P4", journeyStage: "用药安全", journeyStageNo: null, weight: 0.1, isControl: false },
  sources: [
    site({ domain: "dxy.com", name: "丁香医生", kind: "health_media", layer: "coverage", citedFor: { deepseek: 18 }, route: "market", available: true, price: 120 }),
    site({ domain: "jiankang.cn", name: "都市健康", layer: "coverage", route: "not_in_market", available: false, unavailableBecause: ["refuses_medical"] }),
  ],
});

/** 1,000 rows that matter less than the shape: a kind each, one cited many times and the rest once. */
const many: GeoSourceRow[] = Array.from({ length: 6 }, (_, index) => ({
  id: `src_x${index}`, domain: `site${index}.cn`, name: null, kind: index < 4 ? "news" : "forum", layer: null,
  conditions: { icp: null, newsIndexed: null, medical: null }, impostor: false, cited: { doubao: index === 0 ? 9 : 1 }, mentionsOurs: 0, wrongOurs: 0, market: null,
}));

beforeEach(() => {
  for (const fn of Object.values(client)) fn.mockReset();
  client.getGeoSources.mockResolvedValue(sourcesFilled);
  client.getGeoSource.mockImplementation(async (_geoId: string, id: string) => sourceDetailOf(sourcesFilled.sources.find((row) => row.id === id) ?? sourcesFilled.sources[0]));
  client.getGeoActions.mockResolvedValue({ ...actionsFilled, actions: [effect, safety] });
  client.getGeoClusters.mockResolvedValue(clustersFilled);
  client.getGeoCluster.mockImplementation(async (_geoId: string, id: string) => clusterViewFixture(id));
  client.runGeoStep.mockResolvedValue({ sessionId: "ses_geo_1" });
});

const toolbar = () => document.querySelector("[data-toolbar]") as HTMLElement;
const rowOf = (domain: string): HTMLElement | null => (document.querySelector(`[data-geo-source='${domain}']`)?.closest("li") as HTMLElement | null) ?? null;
const domains = () => [...document.querySelectorAll("[data-geo-source]")].map((node) => node.getAttribute("data-geo-source"));

describe("信源: two views in the band", () => {
  it("switches between who the engines cite and where an article could go, in the address", async () => {
    renderTab();
    await screen.findByText("3 个信源");
    const view = within(toolbar()).getByRole("group", { name: "视图" });
    expect(within(view).getByRole("button", { name: "AI 引用谁" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(within(view).getByRole("button", { name: "可投放" }));
    expect(screen.getByTestId("search")).toHaveTextContent("view=placeable");
    expect(await screen.findByRole("list", { name: "可投放的信源" })).toBeInTheDocument();
    expect(document.querySelector("[data-geo-source]")).toBeNull();
    // the engine and 「只看」 choices belong to the other view and are gone
    expect(within(toolbar()).queryByRole("button", { name: "引擎" })).toBeNull();
  });
});

describe("信源: the pictures above the list", () => {
  it("draws the kinds of site and the concentration before the list, and a kind is the list's filter", async () => {
    client.getGeoSources.mockResolvedValue({ ...sourcesFilled, sources: many });
    renderTab();
    await screen.findByText("6 个信源");
    const grid = document.querySelector("[data-chart-grid]") as HTMLElement;
    const list = screen.getByRole("list", { name: "信源" });
    expect(grid.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const kinds = within(grid).getByRole("list", { name: "各类站点被引用的次数" });
    // the kinds, the most cited first
    expect(within(kinds).getAllByRole("button").map((button) => button.textContent)).toEqual([expect.stringContaining("新闻媒体"), expect.stringContaining("社区")]);
    await userEvent.click(within(kinds).getAllByRole("button")[1]);
    expect(screen.getByTestId("search")).toHaveTextContent("kind=forum");
    expect(domains()).toEqual(["site4.cn", "site5.cn"]);
    await userEvent.click(within(toolbar()).getByRole("button", { name: /^类型：社区/ }));
    expect(domains()).toHaveLength(6);
  });

  it("names the kind of site cited most among those the platform could name, never 「其他」 as the conclusion", async () => {
    const unnamed: GeoSourceRow[] = [
      { ...many[0], id: "u0", domain: "u0.cn", kind: "其他", cited: { doubao: 50 } },
      { ...many[0], id: "u3", domain: "u3.cn", kind: null, cited: { doubao: 5 } },
      { ...many[1], id: "u1", domain: "u1.cn", kind: "news", cited: { doubao: 4 } },
      { ...many[2], id: "u2", domain: "u2.cn", kind: "encyclopedia", cited: { doubao: 7 } },
    ];
    client.getGeoSources.mockResolvedValue({ ...sourcesFilled, sources: unnamed });
    renderTab();
    await screen.findByText("4 个信源");
    const grid = document.querySelector("[data-chart-grid]") as HTMLElement;
    expect(within(grid).getByRole("heading", { name: "百科是被引用最多的一类，7 次" })).toBeInTheDocument();
    // 「其他」 stays a bar (and a filter): the sites with no kind are real citations
    expect(within(within(grid).getByRole("list", { name: "各类站点被引用的次数" })).getAllByRole("button").map((button) => button.textContent)).toEqual([
      expect.stringContaining("其他"), expect.stringContaining("百科"), expect.stringContaining("新闻媒体"),
    ]);
  });

  it("draws no kinds card where no site has a kind, and the concentration takes the row", async () => {
    client.getGeoSources.mockResolvedValue({ ...sourcesFilled, sources: many.map((row) => ({ ...row, kind: null })) });
    renderTab();
    await screen.findByText("6 个信源");
    const grid = document.querySelector("[data-chart-grid]") as HTMLElement;
    expect(within(grid).queryByRole("list", { name: "各类站点被引用的次数" })).toBeNull();
    expect(grid.querySelector("[data-source-concentration]")).not.toBeNull();
    expect(grid.querySelectorAll("[data-chart-row] > div")).toHaveLength(1);
  });

  it("states the share of the busiest sites as the title, and the sites cited once as a fact of the legend", async () => {
    client.getGeoSources.mockResolvedValue({ ...sourcesFilled, sources: many });
    renderTab();
    await screen.findByText("6 个信源");
    const concentration = document.querySelector("[data-source-concentration]") as HTMLElement;
    const card = concentration.closest("section") as HTMLElement;
    expect(within(card).getByRole("heading", { name: /^前 6 个站占了 100% 的引用$/ })).toBeInTheDocument();
    expect(within(card).queryByText(/只被引用过一次/)).toBeNull();
    expect(concentration).toHaveTextContent("只被引用 1 次");
    expect(concentration).toHaveTextContent("5 个");
  });
});

describe("信源: what the list can be narrowed to", () => {
  it("offers 可投放 and 三条件已核验 from the server's own flags, beside the old ones", async () => {
    renderTab();
    await screen.findByText("3 个信源");
    await userEvent.click(within(toolbar()).getByRole("button", { name: "只看" }));
    expect((await screen.findAllByRole("menuitemradio")).map((item) => item.textContent)).toEqual(["全部信源", "可投放", "三条件已核验", "讲错过我方", "提到过我方", "自有渠道"]);
    await userEvent.click(screen.getByRole("menuitemradio", { name: "可投放" }));
    // 39.net is the one the market lists (it has a price there)
    expect(domains()).toEqual(["39.net"]);
    await userEvent.click(within(toolbar()).getByRole("button", { name: /^只看/ }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "三条件已核验" }));
    expect(domains()).toEqual(["dxy.com", "39.net"]);
  });

  it("narrows to the sites a group is related to: those its actions send articles to and those cited most for it", async () => {
    renderTab();
    await screen.findByText("3 个信源");
    await userEvent.click(within(toolbar()).getByRole("button", { name: "与某群相关" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "效果怎么样、要打多久" }));
    expect(screen.getByTestId("search")).toHaveTextContent(`cluster=${G_EFFECT}`);
    await waitFor(() => expect(client.getGeoCluster).toHaveBeenCalledWith("geo_1", G_EFFECT));
    // dxy.com is the effect group's action's site; the cluster view's own top sites (dxy.cn, baike.baidu.com) add the encyclopedia
    await waitFor(() => expect(domains()).toEqual(["dxy.com", "baike.baidu.com"]));
    await userEvent.click(within(toolbar()).getByRole("button", { name: "清除筛选" }));
    expect(domains()).toHaveLength(3);
  });
});

describe("信源: where an article could go", () => {
  const open = async () => {
    renderTab(geoProject(), "/app/geo/geo_1/sources?view=placeable");
    return screen.findByRole("list", { name: "可投放的信源" });
  };

  it("lists each place once, with the engines that cite it, the groups it serves, its price and whether an order could be placed", async () => {
    const list = await open();
    const places = [...list.querySelectorAll("[data-geo-place]")].map((node) => node.getAttribute("data-geo-place"));
    // the market's first, the brand's own next, what waits or is refused after
    expect(places).toEqual(["dxy.com", "channel:wechat_mp", "jiankang.cn"]);
    const dxy = list.querySelector("[data-geo-place='dxy.com']")!.closest("li") as HTMLElement;
    expect(dxy).toHaveTextContent("丁香医生");
    expect(dxy).toHaveTextContent("被 豆包、DeepSeek 引用");
    const served = within(dxy).getAllByRole("link").map((link) => link.getAttribute("data-geo-cluster-link"));
    expect(served).toEqual([G_EFFECT, G_SAFETY]);
    expect(dxy).toHaveTextContent("120 灵豆");
    expect(dxy.querySelector("[data-geo-place-state]")).toHaveTextContent("现在可以下单");
  });

  it("a place the market lists and the server has not ruled on is called by its name, not marked as a problem", async () => {
    client.getGeoActions.mockResolvedValue({
      ...actionsFilled,
      actions: [{ ...effect, sources: [site({ domain: "phirda.com", name: "药智网", layer: "coverage", route: "market", available: null })] }],
    });
    renderTab(geoProject(), "/app/geo/geo_1/sources?view=placeable");
    const list = await screen.findByRole("list", { name: "可投放的信源" });
    const state = list.querySelector("[data-geo-place='phirda.com'] ")!.closest("li")!.querySelector("[data-geo-place-state]") as HTMLElement;
    expect(state).toHaveTextContent("媒介集市");
    expect(state).toHaveAttribute("data-geo-place-state", "plain");
    expect(state.className).not.toMatch(/warn/);
  });

  it("says the own channel is the brand's to publish and a refused place why, and nothing is worked out again", async () => {
    const list = await open();
    const own = list.querySelector("[data-geo-place='channel:wechat_mp']")!.closest("li") as HTMLElement;
    expect(own.querySelector("[data-geo-place-state]")).toHaveTextContent("自有渠道，发布后贴链接");
    const refused = list.querySelector("[data-geo-place='jiankang.cn']")!.closest("li") as HTMLElement;
    expect(refused.querySelector("[data-geo-place-state]")).toHaveTextContent("媒介集市没有收录；不接医疗稿");
  });

  it("a place that was cited opens its drawer; one nobody cited opens nothing and is not drawn as if it did", async () => {
    const list = await open();
    expect(within(list.querySelector("[data-geo-place='dxy.com']")!.closest("li") as HTMLElement).getByRole("button", { name: /丁香医生/ })).toBeInTheDocument();
    const nobody = list.querySelector("[data-geo-place='jiankang.cn']")!.closest("li") as HTMLElement;
    expect(within(nobody).queryByRole("button")).toBeNull();
    await userEvent.click(within(list.querySelector("[data-geo-place='dxy.com']")!.closest("li") as HTMLElement).getByRole("button", { name: /丁香医生/ }));
    expect(screen.getByTestId("search")).toHaveTextContent("source=dxy.com");
    expect(await screen.findByRole("dialog", { name: "丁香医生" })).toBeInTheDocument();
  });

  it("with no action yet, says where the places come from and offers the way to the actions", async () => {
    client.getGeoActions.mockResolvedValue({ ...actionsFilled, actions: [] });
    renderTab(geoProject(), "/app/geo/geo_1/sources?view=placeable");
    expect(await screen.findByText(/推荐的投放去处跟着行动来/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "去看行动" })).toBeInTheDocument();
  });

  it("a group narrows the places to the ones its actions send an article to", async () => {
    renderTab(geoProject(), `/app/geo/geo_1/sources?view=placeable&cluster=${G_SAFETY}`);
    const list = await screen.findByRole("list", { name: "可投放的信源" });
    expect([...list.querySelectorAll("[data-geo-place]")].map((node) => node.getAttribute("data-geo-place"))).toEqual(["dxy.com", "jiankang.cn"]);
    // ...and one that has no action has none
    expect(G_BRAND).not.toBe(G_SAFETY);
  });
});

describe("信源: a site's drawer", () => {
  it("opens at the site's own address, and a link from elsewhere lands on it", async () => {
    renderTab(geoProject(), "/app/geo/geo_1/sources?source=baike.baidu.com");
    const dialog = await screen.findByRole("dialog", { name: "百度百科" });
    expect(dialog.querySelector("[data-geo-source-drawer='baike.baidu.com']")).not.toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: /^关闭/ }));
    await waitFor(() => expect(screen.getByTestId("search")).not.toHaveTextContent("source="));
  });

  it("puts what an article there needs and costs, and where it could be placed, ahead of the answers, with the groups it serves", async () => {
    renderTab(geoProject(), "/app/geo/geo_1/sources?source=dxy.com");
    const dialog = await screen.findByRole("dialog", { name: "丁香医生" });
    const conditions = dialog.querySelector("[data-geo-source-detail]") as HTMLElement;
    expect(conditions).toHaveTextContent("层级 覆盖");
    expect(conditions).toHaveTextContent("备案");
    const route = dialog.querySelector("[data-geo-source-route]") as HTMLElement;
    expect(route).toHaveTextContent("媒介集市");
    const served = dialog.querySelector("[data-geo-source-groups]") as HTMLElement;
    expect(within(served).getAllByRole("link").map((link) => link.getAttribute("data-geo-cluster-link"))).toEqual([G_EFFECT, G_SAFETY]);
    const answers = await within(dialog).findByRole("region", { name: "引用它的回答" });
    for (const first of [conditions, served]) expect(first.compareDocumentPosition(answers) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("opening one site after another replaces the address, never stacks two drawers", async () => {
    renderTab();
    await screen.findByText("3 个信源");
    await userEvent.click(within(rowOf("dxy.com")!).getByRole("button", { name: /丁香医生/ }));
    expect(await screen.findByRole("dialog", { name: "丁香医生" })).toBeInTheDocument();
    expect(screen.getByTestId("search")).toHaveTextContent("source=dxy.com");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });
});
