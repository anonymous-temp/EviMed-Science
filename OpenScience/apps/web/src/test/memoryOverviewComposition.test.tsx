import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handoverEntries, livedIn, ownerFirstDay, receivedPack, TODAY } from "@/components/memory/overview/__fixtures__/overviewDocs";
import { MemoryOverviewPage } from "@/app/routes/MemoryOverviewPage";
import userEvent from "@testing-library/user-event";
import { compositionFacts } from "./compositionFixtures";
import { expectComposed } from "./expectComposed";

/** Hold the real summary and received-management modes to the data-page budgets.
 * jsdom verifies document order, semantic destinations, compact history and read
 * states; browser geometry and assistive-technology acceptance remain separate.
 */

const here = dirname(fileURLToPath(import.meta.url));
const table = JSON.parse(readFileSync(join(here, "../../../../scripts/ops/page-templates.json"), "utf8")) as {
  budgets: { data: { typePairs: number; controls: number } };
  views: Array<{ view: string; shapes?: number; template: string; budget?: string }>;
};
const entry = table.views.find((view) => view.view === "memory-overview")!;

const reads = vi.hoisted(() => ({ map: vi.fn(), received: vi.fn(), mine: vi.fn(), preview: vi.fn(), methods: vi.fn() }));
vi.mock("@/lib/methodsClient", async () => ({ ...(await vi.importActual<typeof import("@/lib/methodsClient")>("@/lib/methodsClient")), listAllMethods: reads.methods }));
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

function draw(query = "") {
  return render(
    <MemoryRouter initialEntries={[`/app/memory/overview${query}`]}>
      <Routes><Route path="/app/memory/overview" element={<MemoryOverviewPage />} /></Routes>
    </MemoryRouter>,
  );
}
const loaded = () => waitFor(() => {
  expect(document.querySelectorAll("[data-memory-summary-part]")).toHaveLength(5);
  expect(document.querySelectorAll("[data-memory-summary-part][data-state='loading']")).toHaveLength(0);
}, { timeout: 4_000 });

const learned = (id: string, title: string, at: string) => ({
  id, projectId: null, revision: 1, name: `method-${id}`, title, description: "", whenToUse: "", status: "approved", statusReason: null, origin: "inferred", counts: null,
  promotion: { status: "approved", reasons: [], missing: [] }, body: "", createdAt: at, updatedAt: at,
});

const ACCOUNTS: Array<[string, () => void]> = [
  ["the owner's first day", () => {
    reads.map.mockResolvedValue(ownerFirstDay());
    reads.methods.mockResolvedValue([]);
    reads.received.mockResolvedValue([]);
    reads.preview.mockResolvedValue({ scopes: [], empty: true, tooMany: false, card: null, entries: [] });
  }],
  ["an account that has lived a while", () => {
    reads.map.mockResolvedValue(livedIn());
    reads.methods.mockResolvedValue([learned("m1", "证据矩阵先行", "2026-09-24T02:00:00.000Z"), learned("m2", "先写方法学限制", "2026-10-02T02:00:00.000Z")]);
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
    expect(pairs).toContain("ui/normal");
  });

  it("keeps observed document and memory history compact, even before any personal memory exists", async () => {
    const { container } = draw();
    await loaded();
    expect(container.querySelectorAll("[data-chart]")).toHaveLength(0);
    const history = screen.getByRole("list", { name: "最近的记忆变化" });
    expect(within(history).getAllByRole("listitem").length).toBeGreaterThan(0);
    expect(within(history).getAllByRole("listitem").length).toBeLessThanOrEqual(5);
    expect(screen.getByRole("link", { name: "在地图里看" })).toHaveAttribute("href", expect.stringContaining("/app/memory/map"));
    expect(screen.queryByText("开始积累你的记忆")).not.toBeInTheDocument();
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

  it("keeps five content destinations and opens received management with a return", async () => {
    const { container } = draw("?retained=scope");
    await loaded();
    const expected = _name === "the owner's first day" ? [0, 2, 0, 47, 0] : [4, 2, 2, 39, 2];
    expect([...container.querySelectorAll("[data-memory-summary-part]")].map(row => Number(row.getAttribute("data-count")))).toEqual(expected);
    const list = screen.getByRole("list", { name: "记忆内容与入口" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(5);
    const destinations = [
      ["关于你", `${expected[0]} 件`, "/app/memory/map?part=you"],
      ["项目", `${expected[1]} 个`, "/app/memory/map?part=project"],
      ["我的做法", `${expected[2]} 种`, "/app/memory?tab=methods"],
      ["知识", `${expected[3]} 份`, "/app/memory/map?part=knowledge"],
      ["收到的胶囊", `${expected[4]} 个`, "/app/memory/overview?retained=scope&section=received"],
    ];
    for (const [title, count, target] of destinations) {
      const link = within(list).getByRole("link", { name: new RegExp(title) });
      expect(link).toHaveAttribute("href", target);
      expect(within(link.closest("li")!).getByText(count)).toBeVisible();
    }
    expect([...container.querySelectorAll("[data-memory-summary-part]")].map(row => row.getAttribute("data-memory-summary-part"))).toEqual(["you", "projects", "methods", "knowledge", "received"]);
    expect(compositionFacts(container).clickableTags).toEqual([]);
    await userEvent.click(within(list).getByRole("link", { name: /收到的胶囊/ }));
    expect(container.querySelector("[data-memory-overview-mode='received']")).not.toBeNull();
    expect(screen.queryByRole("list", { name: "记忆内容与入口" })).not.toBeInTheDocument();
    const back = screen.getByRole("link", { name: "返回记忆总览" });
    expect(back).toHaveFocus();
    expect(back).toHaveAttribute("href", "/app/memory/overview?retained=scope");
    if (expected[4] > 0) expect(screen.getAllByRole("switch", { name: /启用“/ })).toHaveLength(expected[4]);
    await userEvent.click(screen.getByRole("link", { name: "返回记忆总览" }));
    expect(screen.getByRole("list", { name: "记忆内容与入口" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /收到的胶囊/ })).toHaveFocus();
  });
});

describe("independent overview states", () => {
  beforeEach(() => {
    reads.map.mockResolvedValue(ownerFirstDay({ summary: { memories: 0, documents: 0, methods: 0, projects: 0, needsLook: 0, since: null }, nodes: [], events: [], buckets: { unit: "day", series: [] }, facets: { projects: [], kinds: [], aboutYou: [], documentTypes: [], topics: [], dimensions: [] } }));
    reads.methods.mockResolvedValue([]);
    reads.received.mockResolvedValue([]);
    reads.preview.mockResolvedValue({ entries: [] });
  });

  it("offers one shared first-use explanation only after every read is empty", async () => {
    const { container } = draw();
    await loaded();
    expect(screen.getAllByText("开始积累你的记忆")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "开始对话" })).toBeInTheDocument();
    expect(container.querySelector("[data-overview-card='growth']")).toBeNull();
    expect(screen.queryByRole("list", { name: "最近的记忆变化" })).not.toBeInTheDocument();
  });

  it("preserves successful content and keeps a failed independent count unknown", async () => {
    reads.map.mockResolvedValue(ownerFirstDay());
    reads.methods.mockRejectedValue(new Error("methods unavailable"));
    const { container } = draw();
    await loaded();
    expect(screen.getByText("暂时读不到学到的做法。")).toBeInTheDocument();
    expect(container.querySelector("[data-memory-summary-part='methods']")).toHaveAttribute("data-state", "error");
    expect(container.querySelector("[data-memory-summary-part='methods']")).not.toHaveAttribute("data-count");
    expect(container.querySelector("[data-memory-summary-part='knowledge']")).toHaveAttribute("data-count", "47");
    expect(screen.getByRole("list", { name: "最近的记忆变化" })).toBeInTheDocument();
    expect(screen.queryByText("开始积累你的记忆")).not.toBeInTheDocument();
  });
});
