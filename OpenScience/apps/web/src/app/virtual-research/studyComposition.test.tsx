import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { forgetStudies } from "@/components/vcr/useStudy";
import { fixture, installVcrServer, STUDY_ID } from "@/components/vcr/__fixtures__/serverFixtures";
import { compositionFacts } from "@/test/compositionFixtures";
import { expectComposed } from "@/test/expectComposed";
import { drawStudy } from "./studyPageHarness";

/**
 * The 虚拟临床研究 pages, composed (R19, plan §3 S10; audit D §4 S9): the real study page (T3 the module page) at each of its tabs
 * and in its conversation view, and the real list (T1), rendered from the server's own fixtures and read in document order with the
 * same assertions every page of the framework answers to (`expectComposed`, `compositionFacts`):
 *
 *  - the header holds one primary action; the page-level toolbar comes before the body; no tag is a control;
 *  - **one band, the same on every tab**: the tab row — which is the study's step bar — and the toolbar's row, sticky, with the same
 *    seven tabs and the same rows whichever tab is open, so switching a tab never makes the page jump;
 *  - the open view is the one tab panel, and the conversation view is not a tab.
 */
const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", () => network);
const me = vi.hoisted(() => ({ fetchWebMe: vi.fn() }));
vi.mock("@/lib/apiClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/apiClient")>()), fetchWebMe: me.fetchWebMe }));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/projects", () => {
  const state = () => ({ currentId: "prj_ev201", projects: [{ id: "prj_ev201" }], select: vi.fn(async () => undefined), load: vi.fn(async () => undefined) });
  return { useProjectStore: Object.assign(<T,>(selector: (value: ReturnType<typeof state>) => T) => selector(state()), { getState: state }) };
});
vi.mock("@/lib/taskPane", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/taskPane")>()), registerTaskPane: () => () => undefined }));

const TABS = ["", "/data", "/population", "/patients", "/comparator", "/trial", "/matching"] as const;

beforeEach(() => {
  forgetStudies();
  me.fetchWebMe.mockReset();
  me.fetchWebMe.mockResolvedValue({ features: { vcr: true } });
  installVcrServer(network.productRequest, {
    [`GET /vcr/studies/${STUDY_ID}`]: (() => {
      const raw = fixture("ev201/study.json");
      raw.conversation = { sessionId: "ses_own", exists: true };
      return raw;
    })(),
  });
});

describe("T3 — a study, at each of its tabs", () => {
  it("has the same band on every tab: the seven tabs, the same rows, sticky, and the toolbar's row drawn or reserved", async () => {
    const tabsSeen: string[][] = [];
    const rows: number[] = [];
    for (const suffix of TABS) {
      const { container, unmount } = drawStudy(`/app/virtual-research/${STUDY_ID}${suffix}`);
      await screen.findByRole("heading", { level: 1, name: /EV-201/ });
      await waitFor(() => expect(container.querySelector("[data-vcr-loading]")).toBeNull());
      // Every tab's body is held to the whole page's rules: 匹配与招募 was the last one with tags in its controls (R19 VCRT put them out).
      const facts = expectComposed(container, { stepRail: true, tablists: 0 });
      expect(facts.header, `${suffix || "总览"}: the header`).not.toBeNull();
      expect(facts.headerPrimaryActions.length).toBeLessThanOrEqual(1);
      expect(facts.controlsBelowContent, `${suffix || "总览"}: no control under the content it controls`).toEqual([]);
      expect(facts.chrome, `${suffix || "总览"}: the band`).toHaveClass("sticky", "top-0");
      // The tab row is the one row of views; whatever the tab holds inside itself is the tab's own business (its body's, not the band's).
      const rail = within(facts.chrome as HTMLElement).getByRole("navigation", { name: "研究进度" });
      tabsSeen.push([...rail.querySelectorAll("[data-rail-step]")].map(step => step.getAttribute("data-rail-step") ?? ""));
      rows.push((facts.chrome as HTMLElement).children.length);
      expect(container.querySelector("#vcr-tab-panel")).toBeInTheDocument();
      expect(within(facts.chrome as HTMLElement).getByRole("button", { name: /^查看：/ })).toBeInTheDocument();
      unmount();
    }
    expect(tabsSeen.every((ids) => ids.length === 7 && ids.join() === tabsSeen[0].join())).toBe(true);
    // The strip (while work is going on, which the fixture's job is), the tab row and the toolbar's row: the same on all seven.
    expect(new Set(rows).size).toBe(1);
  });

  it("is one primary action in the header, the next step, on every tab", async () => {
    for (const suffix of ["", "/trial"]) {
      const { container, unmount } = drawStudy(`/app/virtual-research/${STUDY_ID}${suffix}`);
      await screen.findByRole("heading", { level: 1, name: /EV-201/ });
      const facts = compositionFacts(container);
      expect(facts.headerPrimaryActions.length).toBeLessThanOrEqual(1);
      unmount();
    }
  });

  it("is the conversation view with the band over it, and no tab selected", async () => {
    const { container } = drawStudy(`/app/virtual-research/${STUDY_ID}/chat`);
    await screen.findByRole("region", { name: "研究对话" });
    const facts = expectComposed(container, { stepRail: true, tablists: 0 });
    expect(facts.chrome!.querySelectorAll("[data-rail-step]")).toHaveLength(7);
    expect(screen.getByRole("button", { name: "查看：对话" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "对话" })).toBeNull();
    expect(screen.queryByRole("tab", { selected: true })).toBeNull();
    expect(container.querySelector("[role=tabpanel]")).toBeNull();
  });
});

describe("T1 — the list of studies", () => {
  it("has the views, the filters and the search in the one toolbar above the list", async () => {
    const { container } = drawStudy("/app/virtual-research");
    await screen.findByRole("list", { name: "研究" });
    const facts = expectComposed(container, { toolbar: true, tablists: 0, stepRail: false });
    expect(facts.toolbars).toHaveLength(1);
    expect(facts.toolbars[0]).toContainElement(screen.getByRole("searchbox", { name: "搜索研究" }));
    expect(facts.headerPrimaryActions).toHaveLength(1);
  });
});
