import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GeoProject } from "@/lib/geoClient";
import { geoProject, journeyFilled } from "../__fixtures__/geoTabs";
import { clusterRow, clustersFilled, clusterViewFixture, G_BRAND, G_CONTROL, G_EFFECT, G_SAFETY, questionSetFixture } from "../__fixtures__/geoSpine";
import { GeoFrameHarness } from "../__fixtures__/geoFrameHarness";
import { QuestionsTab } from "./QuestionsTab";

const client = vi.hoisted(() => ({
  getGeoQuestions: vi.fn(),
  getGeoClusters: vi.fn(),
  getGeoCluster: vi.fn(),
  getGeoJourney: vi.fn(),
  unmeasureGeoQuestion: vi.fn(),
  runGeoStep: vi.fn(),
}));
vi.mock("@/lib/geoClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/geoClient")>()),
  ...client,
}));

const store = vi.hoisted(() => ({
  select: vi.fn(async (_projectId: string, land?: () => void) => { land?.(); }),
  load: vi.fn(async () => undefined),
}));
vi.mock("@/lib/projects", () => ({
  useProjectStore: { getState: () => ({ projects: [{ id: "prj_geo_1" }], select: store.select, load: store.load }) },
}));

const conversation = vi.hoisted(() => ({ open: vi.fn(async () => true) }));
vi.mock("../useOpenGeoConversation", () => ({ useOpenGeoConversation: () => conversation.open }));

function Probe() {
  const location = useLocation();
  return (
    <>
      <div data-testid="location">{location.pathname}</div>
      <div data-testid="search">{location.search}</div>
    </>
  );
}

function renderTab(project: GeoProject = geoProject(), path = "/app/geo/geo_1/questions") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/app/geo/geo_1/questions"
          element={<><GeoFrameHarness project={project} tab="questions"><QuestionsTab geoId="geo_1" project={project} /></GeoFrameHarness><Probe /></>}
        />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** A group's row on the page, or null; its name is the row's one control. */
const rowOf = (id: string): HTMLElement | null => (document.querySelector(`[data-geo-group='${id}']`)?.closest("li") as HTMLElement | null) ?? null;
const findRow = (id: string) => waitFor(() => {
  const row = rowOf(id);
  if (!row) throw new Error(`no row for ${id}`);
  return row;
});

beforeEach(() => {
  for (const fn of Object.values(client)) fn.mockReset();
  conversation.open.mockClear();
  store.select.mockClear();
  client.getGeoQuestions.mockResolvedValue(questionSetFixture());
  client.getGeoClusters.mockResolvedValue(clustersFilled);
  client.getGeoCluster.mockImplementation(async (_geoId: string, id: string) => clusterViewFixture(id));
  client.getGeoJourney.mockResolvedValue(journeyFilled);
  client.unmeasureGeoQuestion.mockResolvedValue({});
  client.runGeoStep.mockResolvedValue({ sessionId: "ses_geo_1" });
});

describe("问题与回答: the groups", () => {
  it("files the groups under the pools' one vocabulary, a row each, with the number stripped from the name", async () => {
    renderTab();
    await findRow(G_BRAND);
    for (const heading of ["存量", "增量", "风险监测"]) expect(screen.getByRole("heading", { name: new RegExp(`^${heading}`) })).toBeInTheDocument();
    // The second set of the pools' names (品牌明确类 …) is nowhere on the page: one vocabulary.
    expect(screen.queryByText(/品牌明确类|通用名与品类类|泛症状场景类|风险监测类/)).toBeNull();
    const brand = await findRow(G_BRAND);
    expect(brand).toHaveTextContent("品牌身份、规格与厂家");
    expect(brand).not.toHaveTextContent("P1-01");
    expect(rowOf(G_EFFECT)).toHaveTextContent("效果怎么样、要打多久");
    expect(rowOf(G_SAFETY)).toHaveTextContent("说明书安全题组");
    // the two groups of a pool are listed under it together
    const increments = screen.getByRole("list", { name: "增量的问题群" });
    expect(within(increments).getAllByRole("listitem")).toHaveLength(2);
  });

  it("says a group in counts: what it asks, how many real phrasings, how often we were named, what was misstated, what is done", async () => {
    renderTab();
    const effect = await findRow(G_EFFECT);
    // stage · measured questions · real phrasings (the group's own counts, from the question set)
    expect(effect).toHaveTextContent("2 问");
    expect(effect).toHaveTextContent("0 条原话");
    const brand = await findRow(G_BRAND);
    expect(brand).toHaveTextContent("2 问");
    expect(brand).toHaveTextContent("2 条原话");
    // 被提到 k/n, 讲错, 行动, 稿件: the four columns the header names
    expect(within(brand).getByRole("button", { name: /被提到/ })).toHaveTextContent("11/12");
    expect(within(brand).getByRole("button", { name: /讲错/ })).toHaveTextContent("2");
    expect(within(brand).getByRole("button", { name: /行动/ })).toHaveTextContent("1");
    for (const column of ["被提到", "讲错", "行动", "稿件"]) expect(screen.getAllByRole("button", { name: `按${column}排序` }).length).toBeGreaterThan(0);
  });

  it("draws no percentage for a reading the platform held back, and the rate where it sent one", async () => {
    renderTab();
    const thin = await findRow(G_BRAND);
    expect(thin).toHaveTextContent("11/12");
    expect(thin.textContent).not.toMatch(/%/);
    const empty = await findRow(G_EFFECT);
    expect(empty).toHaveTextContent("0/12");
    expect(empty.textContent).not.toMatch(/%/);
    const enough = await findRow(G_SAFETY);
    expect(enough).toHaveTextContent("21/36");
    expect(enough).toHaveTextContent("58%");
  });

  it("marks a control group once, and says what writing for it does", async () => {
    renderTab();
    const control = await findRow(G_CONTROL);
    const tag = within(control).getByText("对照组");
    expect(tag).toHaveAttribute("data-tag");
    // a tag is not a control (page-structure rule 5)
    expect(tag.closest("button, a")).toBeNull();
    await userEvent.hover(tag);
    expect(await screen.findByText(/退出对照组/)).toBeInTheDocument();
  });

  it("opens the group's drawer from its row, and every count opens what it counts", async () => {
    renderTab();
    const brand = await findRow(G_BRAND);
    await userEvent.click(within(brand).getByRole("button", { name: /^.*品牌身份、规格与厂家$/ }));
    await waitFor(() => expect(screen.getByTestId("search")).toHaveTextContent(`group=${G_BRAND}`));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(document.querySelector(`[data-geo-cluster-drawer='${G_BRAND}']`)).not.toBeNull();
    expect(client.getGeoCluster).toHaveBeenCalledWith("geo_1", G_BRAND);
  });

  it("sends the wrong-count to the group's errors and the action count to the group's actions, each narrowed to the group", async () => {
    renderTab();
    const brand = await findRow(G_BRAND);
    await userEvent.click(within(brand).getByRole("button", { name: /讲错/ }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/geo/geo_1/accuracy"));
    expect(screen.getByTestId("search")).toHaveTextContent(`cluster=${G_BRAND}`);
  });

  it("sends the action count to 行动", async () => {
    renderTab();
    const effect = await findRow(G_EFFECT);
    await userEvent.click(within(effect).getByRole("button", { name: /行动/ }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/geo/geo_1/actions"));
    expect(screen.getByTestId("search")).toHaveTextContent(`cluster=${G_EFFECT}`);
  });

  it("sorts a pool by a column: the most named first, again to reverse", async () => {
    client.getGeoClusters.mockResolvedValue({
      ...clustersFilled,
      groups: [
        clusterRow({ id: "a", name: "P2-01 甲群", pool: "P2", byEngine: { doubao: { answered: 4, mentioned: 1, wrong: 0 } } }),
        clusterRow({ id: "b", name: "P2-02 乙群", pool: "P2", byEngine: { doubao: { answered: 4, mentioned: 4, wrong: 0 } } }),
      ],
    });
    client.getGeoQuestions.mockResolvedValue({
      sets: [{ version: 1, lockedAt: null, measuredCount: 2 }],
      version: 1,
      groups: [
        { id: "a", pool: "P2", name: "P2-01 甲群", typicalQuestion: "", journeyStage: null, audience: "patient", weight: 1, isControl: false, signal: null, questions: [] },
        { id: "b", pool: "P2", name: "P2-02 乙群", typicalQuestion: "", journeyStage: null, audience: "patient", weight: 1, isControl: false, signal: null, questions: [] },
      ],
    });
    renderTab();
    await findRow("a");
    const names = () => [...document.querySelectorAll("[data-geo-group]")].map((node) => node.getAttribute("data-geo-group"));
    expect(names()).toEqual(["a", "b"]);
    await userEvent.click(screen.getByRole("button", { name: "按被提到排序" }));
    expect(names()).toEqual(["b", "a"]);
    await userEvent.click(screen.getByRole("button", { name: /^按被提到排序，当前从多到少/ }));
    expect(names()).toEqual(["a", "b"]);
  });
});

describe("问题与回答: the band's toolbar", () => {
  it("holds the view switch, the pool chips and the search, and nothing that filters stands under the list", async () => {
    renderTab();
    await findRow(G_BRAND);
    const toolbar = document.querySelector("[data-toolbar]") as HTMLElement;
    expect(toolbar).not.toBeNull();
    for (const label of ["按问句池", "按旅程", "全部问句"]) expect(within(toolbar).getByRole("button", { name: label })).toBeInTheDocument();
    for (const label of ["全部", "存量", "增量", "风险监测"]) expect(within(toolbar).getByRole("button", { name: label })).toBeInTheDocument();
    expect(within(toolbar).getByRole("searchbox", { name: "搜索问题" })).toBeInTheDocument();
    // the page's own body filters nothing: every search box and every chip group is the toolbar's
    for (const search of document.querySelectorAll("input[type='search']")) expect(toolbar.contains(search)).toBe(true);
    for (const group of document.querySelectorAll("[role='group'][aria-label]")) {
      if (group.getAttribute("aria-label") === "按数字排序") continue;
      expect(toolbar.contains(group), group.getAttribute("aria-label") ?? "").toBe(true);
    }
  });

  it("narrows to a pool by its chip, and a pool nobody is in has no chip", async () => {
    renderTab();
    await findRow(G_BRAND);
    expect(screen.queryByRole("button", { name: "泛增量" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "风险监测" }));
    expect(rowOf(G_SAFETY)).not.toBeNull();
    expect(rowOf(G_BRAND)).toBeNull();
    expect(rowOf(G_EFFECT)).toBeNull();
  });

  it("finds a question by a word of it, keeps the groups it is in and says how many questions matched", async () => {
    renderTab();
    await findRow(G_BRAND);
    expect(screen.getByText("4 个问题群 · 6 问 · 2 条真实问法")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索问题" }), "哪家公司");
    expect(screen.getByText("匹配 1 个问题")).toBeInTheDocument();
    expect(rowOf(G_BRAND)).toHaveTextContent("匹配：信尔美是哪家公司生产的？");
    expect(rowOf(G_EFFECT)).toBeNull();
    // a word that names the group keeps every question in it
    await userEvent.clear(screen.getByRole("searchbox", { name: "搜索问题" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索问题" }), "安全题组");
    expect(rowOf(G_SAFETY)).not.toBeNull();
    expect(rowOf(G_BRAND)).toBeNull();
    await userEvent.clear(screen.getByRole("searchbox", { name: "搜索问题" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索问题" }), "不存在的词");
    expect(screen.getByText("没有包含“不存在的词”的问题。")).toBeInTheDocument();
  });
});

describe("问题与回答: every question", () => {
  const open = async () => {
    renderTab();
    await findRow(G_BRAND);
    await userEvent.click(screen.getByRole("button", { name: "全部问句" }));
    await waitFor(() => expect(screen.getByTestId("search")).toHaveTextContent("view=all"));
  };

  it("lists the questions with the group each belongs to as a link, and the whole row of a measured one is the way to its answer", async () => {
    await open();
    const asked = (await waitFor(() => {
      const node = document.querySelector("[data-geo-question='q_brand_1']");
      if (!node) throw new Error("no q_brand_1");
      return node;
    })).closest("li") as HTMLElement;
    const link = within(asked).getByRole("link", { name: /看回答/ });
    expect(link).toHaveAttribute("href", "/app/geo/geo_1/answers/s_1");
    expect(link).toHaveTextContent("信尔美是什么药？");
    expect(link.className).toMatch(/after:absolute/);
    // the group's name is a link to the group's drawer, and it keeps the view the person is in
    const group = within(asked).getByRole("link", { name: "品牌身份、规格与厂家" });
    expect(group).toHaveAttribute("data-geo-cluster-link", G_BRAND);
    expect(group.getAttribute("href")).toContain(`group=${G_BRAND}`);
    expect(group.getAttribute("href")).toContain("view=all");
  });

  it("names a platform in words, and says a real phrasing that is not measured is not", async () => {
    await open();
    const asked = (document.querySelector("[data-geo-question='q_brand_2']") as HTMLElement).closest("li") as HTMLElement;
    expect(asked).toHaveTextContent("真实问法 · 知乎");
    const phrase = (document.querySelector("[data-geo-question='q_brand_phrase']") as HTMLElement).closest("li") as HTMLElement;
    expect(phrase).toHaveTextContent("真实问法 · 小红书 · 不在测量里");
    expect(screen.queryByText(/\bxhs\b|\bzhihu\b/)).toBeNull();
    // one never asked has nothing to open and is not drawn as if it had
    const never = (document.querySelector("[data-geo-question='q_eff_2']") as HTMLElement).closest("li") as HTMLElement;
    expect(within(never).queryByRole("link", { name: /看回答/ })).toBeNull();
    expect(never.className).not.toMatch(/hover:/);
  });

  it("removes a measured question from measurement with the row's own 「⋯」, and reads both lists again", async () => {
    await open();
    const row = (document.querySelector("[data-geo-question='q_brand_1']") as HTMLElement).closest("li") as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "“信尔美是什么药？”的操作" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "移出测量问句" }));
    await waitFor(() => expect(client.unmeasureGeoQuestion).toHaveBeenCalledWith("geo_1", "q_brand_1"));
    // the project's reads are stale and read once more, behind the page: not twice
    await waitFor(() => expect(client.getGeoQuestions).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(client.getGeoClusters).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.getGeoQuestions).toHaveBeenCalledTimes(2);
  });
});

describe("问题与回答: by journey", () => {
  it("draws the emotion curve first and the groups in the stage they belong to, by the stage's number where the run wrote one", async () => {
    renderTab(geoProject(), "/app/geo/geo_1/questions?view=journey");
    const stages = await screen.findByRole("heading", { name: "各阶段的问题群" });
    expect(stages).toBeInTheDocument();
    const grid = document.querySelector("[data-geo-stage-groups]") as HTMLElement;
    // numbered stages come first, in their order; a group without a number comes after them under its own words
    const keys = [...grid.querySelectorAll("[data-geo-stage]")].map((node) => node.getAttribute("data-geo-stage"));
    expect(keys).toEqual(["no:1", "no:2", "name:用药安全"]);
    const second = grid.querySelector("[data-geo-stage='no:2']") as HTMLElement;
    expect(within(second).getByRole("link", { name: "效果怎么样、要打多久" })).toHaveAttribute("data-geo-cluster-link", G_EFFECT);
    expect(within(second).getByRole("link", { name: "对照一" })).toBeInTheDocument();
    expect(within(second).getByText("对照组")).toBeInTheDocument();
    // the switch is the band's, and the curve's own switch is beside it
    const toolbar = document.querySelector("[data-toolbar]") as HTMLElement;
    expect(within(toolbar).getByRole("button", { name: "按旅程" })).toHaveAttribute("aria-pressed", "true");
    expect(client.getGeoJourney).toHaveBeenCalled();
  });

  it("says each group in the stage as a count, and a group's name opens its drawer", async () => {
    renderTab(geoProject(), "/app/geo/geo_1/questions?view=journey");
    await screen.findByRole("heading", { name: "各阶段的问题群" });
    const first = document.querySelector("[data-geo-stage='no:1']") as HTMLElement;
    expect(first).toHaveTextContent("11/12");
    expect(first).toHaveTextContent("讲错 1");
    await userEvent.click(within(first).getByRole("link", { name: "品牌身份、规格与厂家" }));
    await waitFor(() => expect(screen.getByTestId("search")).toHaveTextContent(`group=${G_BRAND}`));
  });
});
