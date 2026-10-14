import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { brokenPage, compositionFacts, MODULE_TABS, modulePageAt, PAGES, precedes } from "./compositionFixtures";
import { expectComposed } from "./expectComposed";

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
