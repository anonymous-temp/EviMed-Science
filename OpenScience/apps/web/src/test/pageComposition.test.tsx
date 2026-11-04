import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GEO_PROJECT } from "@/components/geo/__fixtures__/geoProjects";
import { actionsFilled, clustersFilled, clusterViewFixture } from "@/components/geo/__fixtures__/geoSpine";
import {
  articlesFilled,
  diagnosisFilled,
  distributionFilled,
  evidenceFilled,
  journeyFilled,
  monitoringFilled,
  questionsFilled,
  sourcesFilled,
  strategyFilled,
  valueFilled,
} from "@/components/geo/__fixtures__/geoTabs";
import { answerFilled } from "@/components/geo/__fixtures__/geoTabs";
import { GEO_TAB_SECTIONS, GEO_TABS, geoSectionId } from "@/components/geo/geoTabs";
import { GeoAnswerPage } from "@/app/routes/GeoAnswerPage";
import { GeoWorkspaceNav } from "@/components/geo/GeoWorkspaceNav";
import { GeoProjectLayout } from "@/app/routes/GeoProjectPage";
import { brokenPage, compositionFacts, MODULE_TABS, modulePageAt, PAGES, precedes } from "./compositionFixtures";
import { expectComposed } from "./expectComposed";

// The real GEO project page (below): its reads are the fixtures the tab tests use.
const geo = vi.hoisted(() => ({
  useGeoFeature: vi.fn(),
  getGeoProject: vi.fn(),
  getGeoDiagnosis: vi.fn(),
  getGeoMonitoring: vi.fn(),
  getGeoStrategy: vi.fn(),
  getGeoEvidence: vi.fn(),
  getGeoValue: vi.fn(),
  getGeoQuestions: vi.fn(),
  getGeoJourney: vi.fn(),
  getGeoSources: vi.fn(),
  getGeoArticles: vi.fn(),
  getGeoArticleCatalog: vi.fn(),
  getGeoArticle: vi.fn(),
  getGeoDistribution: vi.fn(),
  getGeoActions: vi.fn(),
  getGeoClusters: vi.fn(),
  getGeoCluster: vi.fn(),
  getGeoAnswer: vi.fn(),
}));
vi.mock("@/lib/geoClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/geoClient")>()), ...geo }));

function seedArticleCatalog() {
  geo.getGeoArticleCatalog.mockImplementation(async (_geoId: string, input: { review?: boolean; limit: number; offset: number }) => {
    const rows = articlesFilled.articles.filter(article => !input.review || article.safety === "open" && article.status !== "withdrawn");
    return { articles: rows.slice(input.offset, input.offset + input.limit), total: rows.length, snapshot: "a".repeat(32), limit: input.limit, offset: input.offset };
  });
  geo.getGeoArticle.mockImplementation(async (_geoId: string, id: string) => articlesFilled.articles.find(article => article.id === id));
}
vi.mock("@/lib/geoAnalysisClient", async (original) => ({
  ...(await original<typeof import("@/lib/geoAnalysisClient")>()),
  getGeoAnalysis: vi.fn().mockRejectedValue(new Error("analysis unavailable")),
}));
vi.mock("@/components/geo/useOpenGeoConversation", () => ({ useOpenGeoConversation: () => vi.fn().mockResolvedValue(true) }));

/**
 * The pages of the framework, composed (R19, plan §3 S10; audit D §4 S9): one representative page per template, rendered from
 * fixtures, and what is said about every one of them is a property of how the page is **put together** — read in document order,
 * because jsdom has no layout. Position and measure are the walk's (`scripts/ops/ui-walk.mjs`); this is what holds in CI, on
 * every commit, with no browser.
 *
 *  - the page-level toolbar comes before the body, and no toolbar stands under the content it controls;
 *  - a page has at most one view-switch row;
 *  - the header holds at most one primary action;
 *  - a module's step rail is on **every** tab, with the same steps, in the band, and the band has the same rows on every tab;
 *  - a tag is never a control, and is never inside one.
 *
 * A page package that moves a real page onto the framework renders it and calls `expectComposed(container)` (`expectComposed.ts`),
 * which states all of these in one line, or reads `compositionFacts(container)` for its own; `PAGES` in
 * `compositionFixtures.tsx` is where a sample of the page goes to be held by the same tests below.
 */

afterEach(() => vi.restoreAllMocks());

const WITH_TOOLBAR = new Set(["T1", "T3", "T4"]);
const WITH_TABLIST = new Set(["T1", "T3", "T4"]);

describe.each(PAGES)("$id $name", (sample) => {
  it("has a header, then — if it has any controls — the toolbar, then the body, in that order", () => {
    const { container } = render(sample.element());
    const facts = compositionFacts(container);
    expect(facts.header, "header").not.toBeNull();
    expect(facts.body, "body").not.toBeNull();
    expect(precedes(facts.header!, facts.body!)).toBe(true);
    expect(facts.toolbars.length > 0).toBe(WITH_TOOLBAR.has(sample.id));
    for (const toolbar of facts.toolbars) {
      expect(facts.body!.contains(toolbar), "the page's toolbar is not in the body").toBe(false);
      expect(precedes(facts.header!, toolbar)).toBe(true);
      expect(precedes(toolbar, facts.body!), "the toolbar comes before the first body block").toBe(true);
    }
    expect(facts.controlsBelowContent).toEqual([]);
  });

  it("has at most one row of views, and the page that has controls has exactly one", () => {
    const { container } = render(sample.element());
    const { tablists } = compositionFacts(container);
    expect(tablists.length).toBe(WITH_TABLIST.has(sample.id) ? 1 : 0);
  });

  it("has at most one primary action in the header", () => {
    const { container } = render(sample.element());
    expect(compositionFacts(container).headerPrimaryActions.length).toBeLessThanOrEqual(1);
  });

  it("holds no tag that is a control or sits in one", () => {
    const { container } = render(sample.element());
    expect(compositionFacts(container).clickableTags).toEqual([]);
  });

  it("does not warn about a grid with a hole", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(sample.element());
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("T3 the module page", () => {
  it("has its step rail, fixed in the band, on every tab, with the same eight reachable steps and conditional toolbar rows", () => {
    const steps: string[][] = [];
    const rows: number[] = [];
    const heights: string[] = [];
    for (const tab of MODULE_TABS) {
      const { container, unmount } = render(modulePageAt(tab.value));
      const facts = compositionFacts(container);
      expect(facts.stepRails, `${tab.label}: one rail`).toHaveLength(1);
      expect(facts.chrome!.contains(facts.stepRails[0]), `${tab.label}: the rail is in the sticky band`).toBe(true);
      expect(facts.chrome).toHaveClass("sticky", "top-0");
      steps.push([...facts.stepRails[0].querySelectorAll("[data-rail-step]")].map((step) => step.getAttribute("data-rail-step") ?? ""));
      rows.push(facts.chrome!.children.length);
      heights.push(facts.stepRails[0].className.split(" ").find((name) => /^h-/.test(name)) ?? "");
      unmount();
    }
    expect(steps.every((ids) => ids.length === 8 && ids.join() === steps[0].join())).toBe(true);
    // Keep the rail and view row on every tab; add a toolbar only for actual task controls.
    expect(new Set(rows)).toEqual(new Set([2, 3]));
    expect(new Set(heights)).toEqual(new Set(["h-10"]));
  });

  it("draws a toolbar only when the current task has controls", () => {
    const controlled = render(modulePageAt("visibility"));
    const overview = render(modulePageAt("overview"));
    const facts = compositionFacts(controlled.container);
    expect(facts.toolbars).toHaveLength(1);
    expect(facts.chrome!.contains(facts.toolbars[0])).toBe(true);
    const summary = compositionFacts(overview.container);
    expect(summary.toolbars).toHaveLength(0);
    expect(summary.chrome!.children).toHaveLength(2);
    expect(summary.chrome!.querySelector("[aria-hidden='true'].min-h-11")).toBeNull();
    expect(summary.tablists[0]).toHaveAttribute("aria-label", "项目视图");
  });

  it("underlines the steps the open tab is built from, and moves the underline with the tab", async () => {
    render(modulePageAt("actions"));
    const current = () => [...document.querySelectorAll("[data-step-rail] [aria-current='step']")].map((node) => node.textContent);
    expect(current().map((text) => text?.replace(/，.*/, ""))).toEqual(["内容", "投放"]);
    await userEvent.click(screen.getByRole("tab", { name: "准确与安全" }));
    expect(current().map((text) => text?.replace(/，.*/, ""))).toEqual(["诊断"]);
  });

  it("adds the activity strip under the rail while work is going, and nothing else of the band changes", () => {
    const idle = render(modulePageAt("overview"));
    const idleFacts = compositionFacts(idle.container);
    expect(idle.container.querySelector("[data-activity]")).toBeNull();
    const idleRows = idleFacts.chrome!.children.length;
    idle.unmount();
    const busy = render(modulePageAt("overview", true));
    const facts = compositionFacts(busy.container);
    const strip = busy.container.querySelector("[data-activity='strip']") as HTMLElement;
    expect(facts.chrome!.contains(strip)).toBe(true);
    expect(precedes(facts.stepRails[0], strip)).toBe(true);
    expect(precedes(strip, facts.tablists[0])).toBe(true);
    expect(facts.chrome!.children.length).toBe(idleRows + 1);
  });
});

describe("expectComposed, for a real page", () => {
  it("holds every sample to the same assertions in one call", () => {
    for (const sample of PAGES) {
      const { container, unmount } = render(sample.element());
      const facts = expectComposed(container, { toolbar: WITH_TOOLBAR.has(sample.id), tablists: WITH_TABLIST.has(sample.id) ? 1 : 0, stepRail: sample.id === "T3" });
      expect(facts.body).not.toBeNull();
      unmount();
    }
  });

  it("fails for a page that breaks one", () => {
    const { container } = render(brokenPage("control-below-content"));
    expect(() => expectComposed(container)).toThrow(/no toolbar stands under the content it controls/);
    const second = render(brokenPage("tag-in-control"));
    expect(() => expectComposed(second.container)).toThrow(/no tag is a control/);
  });
});

describe("the assertions can fail", () => {
  it("sees a toolbar written under the list it controls", () => {
    const { container } = render(brokenPage("control-below-content"));
    expect(compositionFacts(container).controlsBelowContent).toHaveLength(1);
  });

  it("sees a tag that is inside a control", () => {
    const { container } = render(brokenPage("tag-in-control"));
    expect(compositionFacts(container).clickableTags).toHaveLength(1);
  });
});

/**
 * The real 循证 GEO project page (R19, plan §3 S10): the layout over each of its eight tabs, rendered from the fixtures the tab tests
 * use. T3 holds for every one — the rail in the sticky band, the tab row, the toolbar's row before the body — and 总览 is a T4 data
 * page: the sentence, then the numbers, then the body, in that order.
 */
describe("the GEO project page, as a module page (T3) and its overview as a data page (T4)", () => {
  beforeEach(() => {
    geo.useGeoFeature.mockReturnValue("on");
    geo.getGeoProject.mockResolvedValue(GEO_PROJECT);
    geo.getGeoDiagnosis.mockResolvedValue(diagnosisFilled);
    geo.getGeoMonitoring.mockResolvedValue(monitoringFilled);
    geo.getGeoStrategy.mockResolvedValue(strategyFilled);
    geo.getGeoEvidence.mockResolvedValue(evidenceFilled);
    geo.getGeoValue.mockResolvedValue(valueFilled);
    geo.getGeoQuestions.mockResolvedValue(questionsFilled);
    geo.getGeoJourney.mockResolvedValue(journeyFilled);
    geo.getGeoSources.mockResolvedValue(sourcesFilled);
    geo.getGeoArticles.mockResolvedValue(articlesFilled);
    seedArticleCatalog();
    geo.getGeoDistribution.mockResolvedValue(distributionFilled);
    geo.getGeoActions.mockResolvedValue(actionsFilled);
    geo.getGeoClusters.mockResolvedValue(clustersFilled);
    geo.getGeoCluster.mockImplementation(async (_geoId: string, id: string) => clusterViewFixture(id));
  });

  function renderGeo(path: string, withNav = false) {
    return render(
      <MemoryRouter initialEntries={[path]}>
        {withNav && <GeoWorkspaceNav geoId="geo_masi" />}
        <Routes>
          <Route path="/app/geo/:geoId" element={<GeoProjectLayout />}>
            <Route index element={null} />
            <Route path=":tab" element={null} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
  }

  it.each(GEO_TABS)("$label: shows one area tablist and keeps progress in project work", async ({ key }) => {
    const { container } = renderGeo(key === "overview" ? "/app/geo/geo_masi" : `/app/geo/geo_masi/${key}`);
    const selected = {
      overview: "项目对话", plan: "方案", visibility: "可见度", accuracy: "医学核查",
      sources: "引用来源", questions: "问题与回答", actions: "稿件", evidence: "产品依据",
    };
    await screen.findByRole("tab", { name: selected[key], selected: true });
    const facts = expectComposed(container, { stepRail: false, tablists: 1 });
    expect(facts.chrome).toHaveClass("sticky", "top-0");
    expect(screen.queryByRole("button", { name: /^查看：/ })).not.toBeInTheDocument();
    expect(container.querySelector("[data-page-dock] [data-conversation-bar]")).toBeNull();
    expect(Boolean(screen.queryByText(/^任务进度/))).toBe(key === "overview");
  });

  it("opens project task progress and follows a scoped task destination", async () => {
    renderGeo("/app/geo/geo_masi?selectionRef=gsel_exact&questionVersion=4&session=ses_keep");
    const summary = await screen.findByText(/^任务进度/);
    expect(summary.closest("details")).not.toHaveAttribute("open");
    await userEvent.click(summary);
    const task = await screen.findByRole("link", { name: "诊断" });
    const address = new URL(task.getAttribute("href")!, "https://example.test");
    expect(address.pathname).toBe("/app/geo/geo_masi/accuracy");
    expect(address.hash).toBe("#geo-errors");
    for (const [key, value] of [["selectionRef", "gsel_exact"], ["questionVersion", "4"], ["session", "ses_keep"]]) expect(address.searchParams.get(key)).toBe(value);
    await userEvent.click(task);
    await screen.findByRole("tab", { name: "医学核查", selected: true });
    expect(screen.queryByText(/^任务进度/)).not.toBeInTheDocument();
  });

  it("keeps the selected question range in the scoped business view and overview return", async () => {
    const { container } = renderGeo("/app/geo/geo_masi/sources?selectionRef=gsel_exact&questionVersion=4&session=ses_keep", true);
    await waitFor(() => expect(container.querySelector("ul[aria-label='信源']")).not.toBeNull());
    expect(container.querySelector("[data-geo-analysis]")).toBeNull();
    expect(screen.getByRole("button", { name: "分析范围 · 已筛选" })).toBeInTheDocument();
    const back = screen.getByRole("link", { name: "项目工作" });
    const address = new URL(back.getAttribute("href")!, "https://example.test");
    expect(address.searchParams.get("selectionRef")).toBe("gsel_exact");
    expect(address.searchParams.get("questionVersion")).toBe("4");
    expect(address.searchParams.get("session")).toBe("ses_keep");
    await userEvent.click(screen.getByRole("button", { name: "分析视角" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "来源类型覆盖" }));
    expect(await screen.findByRole("heading", { name: "来源类型覆盖" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "信源" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "返回信源" }));
    await screen.findByRole("list", { name: "信源" });
    const returned = new URL(screen.getByRole("link", { name: "项目工作" }).getAttribute("href")!, "https://example.test");
    expect(returned.searchParams.get("selectionRef")).toBe("gsel_exact");
    expect(returned.searchParams.get("questionVersion")).toBe("4");
    expect(returned.searchParams.get("session")).toBe("ses_keep");
    await userEvent.click(screen.getByRole("link", { name: "项目工作" }));
    await screen.findByText(/^任务进度/);
    const scopeLink = screen.getByRole("complementary", { name: "项目资料" }).querySelector("a[href]");
    expect(scopeLink).toHaveAttribute("href", expect.stringContaining("selectionRef=gsel_exact"));
  });

  // The rail's click and a 「需要你」 row end in `#geo-<block>`; a tab that is rebuilt without the id leaves the link landing at the top
  // of the tab and nothing says so (the live walk found three: 诊断, 监测 and 去放行). The table of what a tab promises is data.
  it.each(GEO_TABS.flatMap(tab => GEO_TAB_SECTIONS[tab.key].map(section => ({ key: tab.key, label: tab.label, section }))))("$label opens its promised $section block in the owning workbench", async ({ key, section }) => {
    const { container } = renderGeo(`/app/geo/geo_masi/${key}#${geoSectionId(section)}`);
    await waitFor(() => expect(container.querySelector(`#${geoSectionId(section)}`), `${key}: #${geoSectionId(section)}`).not.toBeNull(), { timeout: 4000 });
  });

  it("project work places product information, progress and execution details after the band", async () => {
    const { container } = renderGeo("/app/geo/geo_masi");
    const product = await screen.findByRole("heading", { name: "产品与范围" });
    const progress = screen.getByText(/^任务进度/);
    const runs = screen.getByRole("button", { name: "执行详情" });
    const facts = compositionFacts(container);
    expect(precedes(facts.chrome!, product)).toBe(true);
    expect(precedes(product, progress)).toBe(true);
    expect(precedes(progress, runs)).toBe(true);
  });
});

/**
 * 行动 is a list under a toolbar with one chart above it (R19, plan §5.5): the band carries the stages, the type, the group and the
 * search; the result's picture comes first in the body; every row's group name is a link (the same drawer, from anywhere); and a
 * control that filters is never under the rows it filters.
 */
describe("the GEO content and monitoring workbenches", () => {
  beforeEach(() => {
    geo.useGeoFeature.mockReturnValue("on");
    geo.getGeoProject.mockResolvedValue(GEO_PROJECT);
    geo.getGeoDiagnosis.mockResolvedValue(diagnosisFilled);
    geo.getGeoMonitoring.mockResolvedValue(monitoringFilled);
    geo.getGeoStrategy.mockResolvedValue(strategyFilled);
    geo.getGeoEvidence.mockResolvedValue(evidenceFilled);
    geo.getGeoValue.mockResolvedValue(valueFilled);
    geo.getGeoArticles.mockResolvedValue(articlesFilled);
    seedArticleCatalog();
    geo.getGeoDistribution.mockResolvedValue({ ...distributionFilled, market: { configured: false }, budget: null, orders: [] });
    geo.getGeoActions.mockResolvedValue(actionsFilled);
    geo.getGeoClusters.mockResolvedValue(clustersFilled);
    geo.getGeoCluster.mockImplementation(async (_geoId: string, id: string) => clusterViewFixture(id));
  });

  it("reads band → toolbar → content work without unrelated effect or budget panels", async () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/app/geo/geo_masi/actions"]}>
        <Routes>
          <Route path="/app/geo/:geoId" element={<GeoProjectLayout />}>
            <Route path=":tab" element={null} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(container.querySelector("[data-geo-actions]")).not.toBeNull(), { timeout: 4000 });
    const facts = expectComposed(container, { stepRail: false, tablists: 1, toolbar: true });
    expect(container.querySelector("[data-geo-effect]")).toBeNull();
    expect(container.querySelector("[data-geo-budget]")).toBeNull();
    const list = container.querySelector("[data-geo-actions]") as HTMLElement;
    const toolbar = facts.toolbars[0];
    for (const [earlier, later] of [[facts.chrome!, list], [toolbar, list]] as const) {
      expect(precedes(earlier, later)).toBe(true);
    }
    // The group's name is a link on its row; the status chips are the toolbar's, in the band.
    expect(list.querySelector("[data-geo-cluster-link]")).not.toBeNull();
    expect(facts.chrome!.contains(toolbar)).toBe(true);
    expect(list.querySelectorAll("[data-toolbar]")).toHaveLength(0);
    expect(facts.clickableTags).toEqual([]);
  });

  it("keeps optional effect history in monitoring with no invisible action-list filters", async () => {
    const { container } = render(<MemoryRouter initialEntries={["/app/geo/geo_masi/actions?step=monitoring"]}>
      <Routes><Route path="/app/geo/:geoId" element={<GeoProjectLayout />}><Route path=":tab" element={null} /></Route></Routes>
    </MemoryRouter>);
    await waitFor(() => expect(container.querySelector("[data-geo-effect]")).not.toBeNull());
    const facts = expectComposed(container, { stepRail: false, tablists: 1, toolbar: true });
    expect(precedes(facts.chrome!, container.querySelector("[data-geo-effect]") as HTMLElement)).toBe(true);
    expect(container.querySelector("[data-geo-actions]")).toBeNull();
    expect(screen.queryByRole("searchbox", { name: "搜索行动" })).not.toBeInTheDocument();
  });
});

/**
 * The other pages of 循证 GEO, each by its template (R19, plan §3): 问题与回答 and 信源 are lists under the band's toolbar (信源 with
 * two pictures above it), 准确与安全 and 可见度 are data pages — the numbers, the charts, then the table of the same rows — and one
 * answer is a reading page: the heading with its one action, then the text. What a page's control filters is never under it, no tag
 * is a control, and the group's name is a link wherever it stands.
 */
describe("the GEO lists, data pages and reading page, each by its template", () => {
  beforeEach(() => {
    geo.useGeoFeature.mockReturnValue("on");
    geo.getGeoProject.mockResolvedValue(GEO_PROJECT);
    geo.getGeoDiagnosis.mockResolvedValue(diagnosisFilled);
    geo.getGeoMonitoring.mockResolvedValue(monitoringFilled);
    geo.getGeoStrategy.mockResolvedValue(strategyFilled);
    geo.getGeoEvidence.mockResolvedValue(evidenceFilled);
    geo.getGeoValue.mockResolvedValue(valueFilled);
    geo.getGeoQuestions.mockResolvedValue(questionsFilled);
    geo.getGeoJourney.mockResolvedValue(journeyFilled);
    geo.getGeoSources.mockResolvedValue(sourcesFilled);
    geo.getGeoArticles.mockResolvedValue(articlesFilled);
    seedArticleCatalog();
    geo.getGeoDistribution.mockResolvedValue({ ...distributionFilled, market: { configured: false }, budget: null, orders: [] });
    geo.getGeoActions.mockResolvedValue(actionsFilled);
    geo.getGeoClusters.mockResolvedValue(clustersFilled);
    geo.getGeoCluster.mockImplementation(async (_geoId: string, id: string) => clusterViewFixture(id));
    geo.getGeoAnswer.mockResolvedValue(answerFilled);
  });

  function renderAt(path: string) {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/app/geo/:geoId" element={<GeoProjectLayout />}>
            <Route index element={null} />
            <Route path="answers/:snapshotId" element={<GeoAnswerPage />} />
            <Route path=":tab" element={null} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
  }

  /** The landmarks of each page, in the order a reader meets them. */
  const ORDER: Record<string, string[]> = {
    questions: ["[data-geo-group]"],
    // Sources lead with their business list; full analysis is an explicit mode.
    sources: ["ul[aria-label='信源']"],
    accuracy: ["[data-chart-grid]", "[data-geo-error-list]"],
    visibility: ["[data-chart='trend']", "[data-heat-row]", "[data-geo-engine-trend]"],
  };

  it.each(Object.keys(ORDER))("%s: the band, then its toolbar, then its landmarks in order, with no control under what it controls", async (key) => {
    const { container } = renderAt(`/app/geo/geo_masi/${key}`);
    for (const selector of ORDER[key]) await waitFor(() => expect(container.querySelector(selector), `${key}: ${selector}`).not.toBeNull(), { timeout: 4000 });
    const facts = expectComposed(container, { stepRail: false, tablists: 1, toolbar: true });
    const body = facts.body as HTMLElement;
    expect(facts.chrome!.contains(facts.toolbars[0])).toBe(true);
    let earlier: Element = facts.toolbars[0];
    for (const selector of ORDER[key]) {
      const found = container.querySelector(selector) as HTMLElement;
      expect(precedes(earlier, found), `${key}: ${selector} follows the one before it`).toBe(true);
      earlier = found;
    }
    // nothing in the body filters: every search box is the band's — except in the embedded selected-data analysis (GEO v3), a workbench of
    // its own whose toolbar stands above the table it controls and filters only that table
    for (const search of body.querySelectorAll("input[type='search']")) expect(search.closest("[data-geo-analysis]"), `${key}: a search box in the body`).not.toBeNull();
    expect(facts.clickableTags).toEqual([]);
  });

  it("a group's name is a link on every page that draws one, opening the same drawer", async () => {
    for (const [key, selector] of [["actions", "[data-geo-actions]"], ["sources", "[data-geo-tab='sources']"]] as const) {
      const { container, unmount } = renderAt(`/app/geo/geo_masi/${key}${key === "sources" ? "?view=placeable" : ""}`);
      await waitFor(() => expect(container.querySelector(selector), key).not.toBeNull(), { timeout: 4000 });
      await waitFor(() => expect(container.querySelector("[data-geo-cluster-link]"), key).not.toBeNull(), { timeout: 4000 });
      unmount();
    }
  });

  it("one answer reads heading → its one action → the text, inside the band, with the date switcher in the band's toolbar", async () => {
    const { container } = renderAt("/app/geo/geo_masi/answers/snap_deepseek");
    const heading = await screen.findByRole("heading", { level: 2, name: "打了减重针一直恶心，要不要停药？" });
    await waitFor(() => expect(container.querySelector("[data-geo-answer]")).not.toBeNull());
    const facts = expectComposed(container, { stepRail: false, tablists: 1, toolbar: true });
    const action = container.querySelector("[data-geo-answer-primary]") as HTMLElement;
    const text = container.querySelector("[data-geo-answer]") as HTMLElement;
    for (const [before, after] of [[facts.chrome!, heading], [heading, action], [action, text]] as const) expect(precedes(before, after)).toBe(true);
    expect(facts.chrome!.contains(facts.toolbars[0])).toBe(true);
    expect(facts.headerPrimaryActions.length).toBeLessThanOrEqual(1);
    // the one question's tab stays selected under the answer
    expect(screen.getByRole("tab", { name: "问题与回答", selected: true })).toBeInTheDocument();
  });
});
