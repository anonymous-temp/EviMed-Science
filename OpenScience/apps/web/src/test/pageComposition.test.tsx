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
import { GEO_TAB_SECTIONS, GEO_TABS, geoSectionId } from "@/components/geo/geoTabs";
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
  getGeoDistribution: vi.fn(),
  getGeoActions: vi.fn(),
  getGeoClusters: vi.fn(),
  getGeoCluster: vi.fn(),
}));
vi.mock("@/lib/geoClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/geoClient")>()), ...geo }));
vi.mock("@/components/geo/useOpenGeoConversation", () => ({ useOpenGeoConversation: () => vi.fn() }));

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
  it("has its step rail, fixed in the band, on every tab, with the same steps and the same rows", () => {
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
    // The rail, the tabs and the toolbar row (drawn or reserved): the same three on all five tabs.
    expect(new Set(rows)).toEqual(new Set([3]));
    expect(new Set(heights)).toEqual(new Set(["h-10"]));
  });

  it("reserves the toolbar's row on a tab that has none, so the band does not jump when the tab changes", () => {
    const withToolbar = render(modulePageAt("visibility"));
    const reserved = render(modulePageAt("overview"));
    const rowOf = (container: HTMLElement) => compositionFacts(container).chrome!.lastElementChild as HTMLElement;
    const drawn = rowOf(withToolbar.container);
    const empty = rowOf(reserved.container);
    expect(drawn).toHaveClass("min-h-11");
    expect(empty).toHaveClass("min-h-11");
    expect(empty).toHaveAttribute("aria-hidden", "true");
    expect(compositionFacts(reserved.container).toolbars).toHaveLength(0);
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
    geo.getGeoDistribution.mockResolvedValue(distributionFilled);
    geo.getGeoActions.mockResolvedValue(actionsFilled);
    geo.getGeoClusters.mockResolvedValue(clustersFilled);
    geo.getGeoCluster.mockImplementation(async (_geoId: string, id: string) => clusterViewFixture(id));
  });

  function renderGeo(path: string) {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/app/geo/:geoId" element={<GeoProjectLayout />}>
            <Route index element={null} />
            <Route path=":tab" element={null} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
  }

  // `SourcesTab`'s row title wraps the site's kind in a Tag, inside the row's own button: three of them in the fixture (rule 5: a tag
  // is not a control). r19-geob restructures that tab; the baseline falls to 0 with it.
  const KNOWN_CLICKABLE_TAGS: Partial<Record<string, number>> = { sources: 3 };

  it.each(GEO_TABS)("$label: the rail is in the sticky band, the tab row is the page's one row of views, and nothing stands under what it controls", async ({ key, label }) => {
    const { container } = renderGeo(key === "overview" ? "/app/geo/geo_masi" : `/app/geo/geo_masi/${key}`);
    await waitFor(() => expect(container.querySelector("[data-geo-tab]")).not.toBeNull(), { timeout: 4000 });
    // The tab's own read has landed when its page-level toolbar (where it has one) is drawn; settle the layout effects.
    await waitFor(() => expect(screen.getByRole("tab", { name: label })).toHaveAttribute("aria-selected", "true"));
    const facts = expectComposed(container, { stepRail: true, tablists: 1, clickableTags: KNOWN_CLICKABLE_TAGS[key] });
    expect(facts.stepRails).toHaveLength(1);
    expect([...facts.stepRails[0].querySelectorAll("[data-rail-step]")]).toHaveLength(8);
    expect(facts.chrome).toHaveClass("sticky", "top-0");
    // The band's rows: the rail, the tabs and the toolbar's row (drawn, or reserved and empty).
    expect(facts.chrome!.children).toHaveLength(3);
  });

  // The rail's click and a 「需要你」 row end in `#geo-<block>`; a tab that is rebuilt without the id leaves the link landing at the top
  // of the tab and nothing says so (the live walk found three: 诊断, 监测 and 去放行). The table of what a tab promises is data.
  it.each(GEO_TABS.filter((tab) => GEO_TAB_SECTIONS[tab.key].length > 0))("$label has the blocks the rail and 「需要你」 scroll to", async ({ key }) => {
    const { container } = renderGeo(`/app/geo/geo_masi/${key}`);
    for (const section of GEO_TAB_SECTIONS[key]) {
      await waitFor(() => expect(container.querySelector(`#${geoSectionId(section)}`), `${key}: #${geoSectionId(section)}`).not.toBeNull(), { timeout: 4000 });
    }
  });

  it("总览 reads sentence → the numbers → what is asked → the trend, in that order, with the band above all of it", async () => {
    geo.getGeoProject.mockResolvedValue({
      ...GEO_PROJECT,
      needsYou: [{ kind: "client_action", key: "client:0a1b2c3d", verb: "do", object: { type: "client_action" }, text: "开通并认证自有微信公众号", target: { tab: "plan", section: "client_actions" } }],
    });
    const { container } = renderGeo("/app/geo/geo_masi");
    await waitFor(() => expect(container.querySelector("[data-headline]")).not.toBeNull(), { timeout: 4000 });
    await screen.findByRole("heading", { name: "需要你" });
    const facts = compositionFacts(container);
    const headline = container.querySelector("[data-headline]") as HTMLElement;
    const stats = screen.getByRole("region", { name: "本轮指标" });
    const asked = screen.getByRole("heading", { name: "需要你" });
    const trend = container.querySelector("[data-chart='trend']") ?? screen.getByRole("heading", { name: /综合可见度指数/ });
    expect(precedes(facts.chrome!, headline)).toBe(true);
    for (const [earlier, later] of [[headline, stats], [stats, asked], [asked, trend]] as const) expect(precedes(earlier, later)).toBe(true);
  });
});

/**
 * 行动 is a list under a toolbar with one chart above it (R19, plan §5.5): the band carries the stages, the type, the group and the
 * search; the result's picture comes first in the body; every row's group name is a link (the same drawer, from anywhere); and a
 * control that filters is never under the rows it filters.
 */
describe("the GEO 行动 page as a list with a chart on top", () => {
  beforeEach(() => {
    geo.useGeoFeature.mockReturnValue("on");
    geo.getGeoProject.mockResolvedValue(GEO_PROJECT);
    geo.getGeoDiagnosis.mockResolvedValue(diagnosisFilled);
    geo.getGeoMonitoring.mockResolvedValue(monitoringFilled);
    geo.getGeoStrategy.mockResolvedValue(strategyFilled);
    geo.getGeoEvidence.mockResolvedValue(evidenceFilled);
    geo.getGeoValue.mockResolvedValue(valueFilled);
    geo.getGeoArticles.mockResolvedValue(articlesFilled);
    geo.getGeoDistribution.mockResolvedValue({ ...distributionFilled, market: { configured: false }, budget: null, orders: [] });
    geo.getGeoActions.mockResolvedValue(actionsFilled);
    geo.getGeoClusters.mockResolvedValue(clustersFilled);
    geo.getGeoCluster.mockImplementation(async (_geoId: string, id: string) => clusterViewFixture(id));
  });

  it("reads band → toolbar → the result's chart → the work, with the filters above all of it and no control under a row", async () => {
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
    const facts = expectComposed(container, { stepRail: true, tablists: 1, toolbar: true });
    const chart = container.querySelector("[data-geo-effect]") as HTMLElement;
    const list = container.querySelector("[data-geo-actions]") as HTMLElement;
    const toolbar = facts.toolbars[0];
    for (const [earlier, later] of [[facts.chrome!, chart], [toolbar, chart], [chart, list]] as const) {
      expect(precedes(earlier, later)).toBe(true);
    }
    // The group's name is a link on its row; the status chips are the toolbar's, in the band.
    expect(list.querySelector("[data-geo-cluster-link]")).not.toBeNull();
    expect(facts.chrome!.contains(toolbar)).toBe(true);
    expect(list.querySelectorAll("[data-toolbar]")).toHaveLength(0);
    expect(facts.clickableTags).toEqual([]);
  });
});
