import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handoverEntries, livedIn, ownerFirstDay, receivedPack, TODAY } from "@/components/memory/overview/__fixtures__/overviewDocs";
import { MemoryOverviewPage } from "@/app/routes/MemoryOverviewPage";
import { memoryOverviewFindings } from "../../../../scripts/ops/ui-walk.mjs";
import { compositionFacts } from "./compositionFixtures";
import { expectComposed } from "./expectComposed";

/**
 * 总览 held to the data-page budget, as far as jsdom can read it (the walk's own numbers are measured in a browser, after a release): the
 * page table gives the budget (`budgets.data`: five size × weight pairs) and the walk's own judge (`memoryOverviewFindings`) reads the page as the
 * probe does, so what this test calls a page the walk would call one.
 *
 *  - **type pairs ≤ 5.** Read off the classes the components set, climbing to the nearest ancestor that names a size and a weight, which is
 *    what the browser's cascade does for the rungs (`TYPE_SCALE`: 12 / 14 / 18 …, weights 400 and 600).
 *  - **one canvas and the rest DOM.** The growth strip is the page's only `[data-chart]`; the other five cards are words and rows.
 *  - **colours from the map's palette only.** No inline colour, no arbitrary-value class, no hex in a class or a style on the page.
 *  - **at most two kinds of section** (`shapes` in the page table), counted as the walk counts them: an element and its first two kinds of child.
 *  - the framework's own assertions (`expectComposed`), and the walk's card judge on the page as drawn.
 */

const here = dirname(fileURLToPath(import.meta.url));
const table = JSON.parse(readFileSync(join(here, "../../../../scripts/ops/page-templates.json"), "utf8")) as {
  budgets: { data: { typePairs: number; controls: number } };
  views: Array<{ view: string; shapes?: number; template: string; budget?: string }>;
};
const entry = table.views.find((view) => view.view === "memory-overview")!;

const reads = vi.hoisted(() => ({ map: vi.fn(), received: vi.fn(), mine: vi.fn(), preview: vi.fn() }));
vi.mock("@/lib/memoryMapClient", async () => ({ ...(await vi.importActual<typeof import("@/lib/memoryMapClient")>("@/lib/memoryMapClient")), fetchMemoryMap: reads.map }));
vi.mock("@/lib/memoryClient", async () => ({
  ...(await vi.importActual<typeof import("@/lib/memoryClient")>("@/lib/memoryClient")), fetchReceivedCapsules: reads.received, fetchMyCapsule: reads.mine,
  fetchProjectOverview: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/productClient", async () => ({ ...(await vi.importActual<typeof import("@/lib/productClient")>("@/lib/productClient")), previewCapsuleExport: reads.preview }));
vi.mock("@/lib/apiClient", async () => ({
  ...(await vi.importActual<typeof import("@/lib/apiClient")>("@/lib/apiClient")),
  fetchMemorySettings: () => Promise.resolve({ learningPaused: false, recallPaused: false, pausedProjects: [], updatedAt: null }),
}));
vi.mock("@/lib/memoryMapFeature", () => ({ useMemoryMapFeature: () => "on" }));
vi.mock("@/components/memory/useMemoryWritePrompt", () => ({ useMemoryWritePrompt: () => {} }));

const SIZE = /^text-(badge|meta|caption|compact|ui-sm|ui|body|wordmark|section|heading|title|doc-title|display|metric-lg|metric|hero)$/;
const WEIGHT = /^font-(normal|semibold)$/;

/** The size and weight an element's text is set in, from its own classes or the nearest ancestor's: base classes only, a variant is a width. */
function rungOf(element: Element, root: Element): string {
  let size: string | null = null;
  let weight: string | null = null;
  for (let at: Element | null = element; at && !size || !weight; at = at?.parentElement ?? null) {
    if (!at) break;
    for (const name of at.className?.toString().split(/\s+/) ?? []) {
      if (!size && SIZE.test(name)) size = name.slice(5);
      if (!weight && WEIGHT.test(name)) weight = name.slice(5);
    }
    if (at === root) break;
  }
  return `${size ?? "ui"}/${weight ?? "normal"}`;
}

/** The distinct size × weight pairs of the text a page holds. */
export function typePairs(root: Element): string[] {
  const pairs = new Set<string>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const element = node.parentElement;
    if (!element || !node.textContent?.trim() || element.closest("[aria-hidden='true'], .sr-only, script, style")) continue;
    pairs.add(rungOf(element, root));
  }
  return [...pairs].sort();
}

const SECTION = "section, ul, ol, table, canvas, svg";
/** The shapes of the sections a page stacks, as the walk reads them: the tag and its first two distinct kinds of child, outermost only. */
function sectionShapes(root: Element): string[] {
  const units = [...root.querySelectorAll(SECTION)].filter((element) => {
    if (element.closest("header, nav, aside, [role='tablist'], [role='dialog'], li, button, a, [role='button']")) return false;
    if (element.matches("ul, ol") && !element.querySelector(":scope > li")) return false;
    const outer = element.parentElement?.closest(SECTION);
    return !(outer && root.contains(outer));
  });
  return [...new Set(units.map((element) => `${element.tagName.toLowerCase()}>${[...new Set([...element.children].map((child) => child.tagName.toLowerCase()))].slice(0, 2).join("+")}`))];
}

function draw() {
  return render(
    <MemoryRouter initialEntries={["/app/memory/overview"]}>
      <Routes><Route path="/app/memory/overview" element={<MemoryOverviewPage />} /></Routes>
    </MemoryRouter>,
  );
}
const loaded = () => waitFor(() => {
  expect(document.querySelectorAll("[data-overview-card]").length).toBe(6);
  expect(document.querySelectorAll("[data-overview-card][data-state='loading']")).toHaveLength(0);
}, { timeout: 4_000 });

/** What the walk's probe reads of the drawn page, rebuilt from the markers (the probe does it in a browser; the judge is the same). */
function probeRead(root: Element) {
  const cards = [...root.querySelectorAll("[data-overview-card]")].map((element) => ({
    part: element.getAttribute("data-overview-card")!, state: element.getAttribute("data-state")!, shape: element.getAttribute("data-shape"),
    count: element.hasAttribute("data-count") ? Number(element.getAttribute("data-count")) : null,
    memories: element.hasAttribute("data-memories") ? Number(element.getAttribute("data-memories")) : null,
    rows: element.querySelectorAll("[data-overview-row]").length,
    bars: [...element.querySelectorAll("ul[aria-label] [role='img'][aria-label]")].map((bar) => Number(/(\d+)\s*$/.exec(bar.getAttribute("aria-label") ?? "")?.[1] ?? Number.NaN)),
    more: Number(element.getAttribute("data-more") ?? 0),
  }));
  return {
    headline: root.querySelector("[data-headline]")?.textContent?.replace(/\s+/g, " ").trim() ?? null,
    tabs: [...root.querySelectorAll("[role='tablist'][aria-label='记忆'] [role='tab']")].map((tab) => tab.textContent ?? ""),
    canvases: root.querySelectorAll("[data-chart]").length, cards,
    look: (() => { const section = root.querySelector("[data-overview-look]"); return section ? { count: Number(section.getAttribute("data-overview-look")), rows: section.querySelectorAll("[data-overview-row]").length } : null; })(),
  };
}

const ACCOUNTS: Array<[string, () => void]> = [
  ["the owner's first day", () => {
    reads.map.mockResolvedValue(ownerFirstDay());
    reads.received.mockResolvedValue([]);
    reads.preview.mockResolvedValue({ scopes: [], empty: true, tooMany: false, card: null, entries: [] });
  }],
  ["an account that has lived a while", () => {
    reads.map.mockResolvedValue(livedIn());
    reads.received.mockResolvedValue([receivedPack("a"), receivedPack("b", { enabled: true })]);
    reads.preview.mockResolvedValue({ scopes: [], empty: false, tooMany: false, card: null, entries: handoverEntries({ methods: 3, standards: 5, background: 12 }) });
  }],
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(TODAY);
  reads.mine.mockResolvedValue({ capsule: { id: "cap_1" }, capsules: [], entries: [], forgotten: [] });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

describe.each(ACCOUNTS)("总览 of %s", (_name, arrange) => {
  beforeEach(arrange);

  it("is a data page of the framework with its band, its sentence and its body in order, and no toolbar", async () => {
    const { container } = draw();
    await loaded();
    expect(entry).toMatchObject({ template: "T4", budget: "data" });
    const facts = expectComposed(container, { tablists: 1 });
    expect(facts.toolbars).toHaveLength(0);
    expect(facts.chrome).not.toBeNull();
  });

  it("sets its text in at most the data page's five size × weight pairs", async () => {
    const { container } = draw();
    await loaded();
    const pairs = typePairs(container);
    expect(table.budgets.data.typePairs).toBe(5);
    expect(pairs.length, pairs.join(", ")).toBeLessThanOrEqual(table.budgets.data.typePairs);
    // No rung of the metric sizes: the cards say a number in a sentence, not in a 32 px figure.
    expect(pairs.some((pair) => pair.startsWith("metric"))).toBe(false);
    expect(pairs.some((pair) => pair.endsWith("/medium"))).toBe(false);
    // Room to spare: the page, the card headings and the sentence share one pair, and the body, the rows and the legends the other two.
    expect(pairs).toEqual(["caption/normal", "section/semibold", "title/semibold", "ui/normal"]);
  });

  it("draws one canvas, the growth strip, and everything else in the document", async () => {
    const { container } = draw();
    await loaded();
    expect([...container.querySelectorAll("[data-chart]")].map((chart) => chart.getAttribute("data-chart"))).toEqual(["growth"]);
    expect(container.querySelectorAll("canvas").length).toBeLessThanOrEqual(1);
    expect(container.querySelectorAll("svg[class*='echarts'], svg:not([class])").length).toBeLessThanOrEqual(1);
  });

  it("uses no colour of its own: no inline colour, no arbitrary-value class, no hex", async () => {
    const { container } = draw();
    await loaded();
    const html = container.innerHTML;
    expect(html).not.toMatch(/#[0-9a-f]{3,8}\b/iu);
    expect(html).not.toMatch(/\b(?:text|bg|border|fill|stroke|ring)-\[/u);
    for (const element of container.querySelectorAll<HTMLElement>("[style]")) {
      const style = element.getAttribute("style") ?? "";
      expect(style, style).not.toMatch(/(?:^|;)\s*(?:color|background(?:-color)?|border(?:-color)?|fill|stroke)\s*:/u);
    }
  });

  it("stacks at most the page table's two kinds of section: the cards, and the list of what needs a look", async () => {
    const { container } = draw();
    await loaded();
    const shapes = sectionShapes(container);
    expect(entry.shapes).toBe(2);
    expect(shapes.length, shapes.join(", ")).toBeLessThanOrEqual(entry.shapes!);
  });

  it("is a page the walk's own judge reads as right: the cards in order, the sentence their numbers, the rows their counts", async () => {
    const { container } = draw();
    await loaded();
    const read = probeRead(container);
    const judged = memoryOverviewFindings("memory-overview@desktop", read);
    expect(judged.failures).toEqual([]);
    expect(compositionFacts(container).clickableTags).toEqual([]);
  });
});
