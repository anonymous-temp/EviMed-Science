import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapEdge, MapNode, MemoryMap } from "@/lib/memoryMapClient";
import { useProjectStore } from "@/lib/projects";
import type { WebStructuredMemory } from "@/lib/apiClient";
import { expectComposed } from "@/test/expectComposed";
import { precedes } from "@/test/compositionFixtures";
import { MemoryMapPage } from "./MemoryMapPage";

const fetchMemoryMap = vi.fn();
const refreshTopics = vi.fn();
const editTopic = vi.fn();
const fetchRecordLinks = vi.fn();
const fetchMemoryProfile = vi.fn();

vi.mock("@/lib/memoryMapClient", async () => ({
  ...(await vi.importActual<typeof import("@/lib/memoryMapClient")>("@/lib/memoryMapClient")),
  fetchMemoryMap: (...args: unknown[]) => fetchMemoryMap(...args),
  refreshTopics: (...args: unknown[]) => refreshTopics(...args),
  editTopic: (...args: unknown[]) => editTopic(...args),
  fetchRecordLinks: (...args: unknown[]) => fetchRecordLinks(...args),
}));
vi.mock("@/lib/apiClient", async () => ({
  ...(await vi.importActual<typeof import("@/lib/apiClient")>("@/lib/apiClient")),
  fetchMemoryProfile: (...args: unknown[]) => fetchMemoryProfile(...args),
}));
vi.mock("@/lib/methodsClient", async () => ({ ...(await vi.importActual<typeof import("@/lib/methodsClient")>("@/lib/methodsClient")), listAllMethods: () => Promise.resolve([]) }));

const memory = (id: string, over: Partial<MapNode> = {}): MapNode => ({
  id: `memory:${id}`, type: "memory", subtype: "preference", group: "偏好", label: `记忆 ${id}`, weight: 0.4, state: "current", at: "2026-09-10T00:00:00.000Z",
  projectId: null, open: { kind: "record", id }, ...over,
});
const edge = (from: string, to: string, type: MapEdge["type"] = "belongs-to", state?: MapEdge["state"]): MapEdge => ({ from, to, type, ...(state ? { state } : {}) });

/** A document big enough to draw: ten memories on the account, one needing a look, a document and a retracted paper. */
function busyMap(over: Partial<MemoryMap> = {}): MemoryMap {
  const memories = Array.from({ length: 10 }, (_, index) => memory(`m${index}`, index === 3 ? { state: "check", reason: "source-retracted", label: "有研究称该药把再入院减半" } : {}));
  const nodes: MapNode[] = [
    { id: "you:account", type: "you", label: "你", state: "current" }, ...memories,
    { id: "document:src_1", type: "document", subtype: "guideline", group: "指南", label: "GOLD 指南", state: "current", open: { kind: "page", href: "/app/files/src_1" } },
    { id: "reference:doi:10.1/x", type: "reference", subtype: "doi", label: "10.1/x", state: "current" },
  ];
  const edges = [
    ...memories.map((node) => edge(node.id, "you:account")),
    edge("memory:m3", "document:src_1", "rests-on", "current"), edge("memory:m3", "reference:doi:10.1/x", "rests-on", "retracted"),
  ];
  return {
    version: 1,
    scope: { projectId: null, range: { from: null, to: "2026-10-12", unit: "month" }, timeZone: "Asia/Shanghai", focus: null, depth: null },
    status: { topics: "ready" },
    summary: { memories: 10, documents: 1, methods: 0, projects: 0, needsLook: 1, since: "2026-09-10" },
    facets: {
      projects: [], kinds: [{ id: "preference", label: "偏好", count: 10 }],
      topics: [{ id: "topic:aaaaaaaaaa", label: "回答风格", weight: 4, trend: 2, members: ["memory:m0", "memory:m1"] }],
      dimensions: [],
    },
    nodes, edges, buckets: { unit: "day", series: [{ t: "2026-10-11", memory: 2, run: 1, method: 0, feedback: 0 }] }, lanes: [],
    events: [{ id: "memory:m1:created", at: "2026-10-11T02:00:00.000Z", type: "memory", change: "created", ref: "memory:m1", lane: "account", kind: "preference", text: "记忆 m1" }],
    truncated: { nodes: 0, edges: 0 }, missing: [],
    ...over,
  };
}

const record = (id: string): WebStructuredMemory => ({
  id, scope: "user", scopeId: "", kind: "preference", key: `k.${id}`, value: `记忆 ${id}`, summary: `记忆 ${id}`, origin: "inferred", status: "active", confidence: 1, importance: 0.5,
  sensitive: false, evidenceCount: 0, version: 1, createdAt: "2026-09-10T00:00:00Z", updatedAt: "2026-09-10T00:00:00Z", lastConfirmedAt: null, expiresAt: null, evidence: [], revisions: [],
});

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname}{location.search}</p>;
}
function open(search = "") {
  return render(
    <MemoryRouter initialEntries={[`/app/memory/map${search}`]}>
      <Where />
      <Routes>
        <Route path="/app/memory/map" element={<MemoryMapPage />} />
        <Route path="/app/memory" element={<p>记忆页</p>} />
        <Route path="/app/files/open" element={<p>知识页的入口</p>} />
        <Route path="/app/files/:id" element={<p>资料页</p>} />
      </Routes>
    </MemoryRouter>,
  );
}
const where = () => screen.getByTestId("where").textContent;
/** One of the five views: a chip of the toolbar's own group, not a second row of tabs. */
const viewChip = (name: string) => within(screen.getByRole("group", { name: "地图的视图" })).getByRole("button", { name });

beforeEach(() => {
  fetchMemoryMap.mockReset().mockResolvedValue(busyMap());
  refreshTopics.mockReset().mockResolvedValue({ status: "ready", made: false });
  editTopic.mockReset();
  fetchRecordLinks.mockReset().mockResolvedValue({ rests: [], replaced: [], replacedBy: null, conflicts: [], usedIn: [] });
  fetchMemoryProfile.mockReset().mockResolvedValue({ records: Array.from({ length: 10 }, (_, index) => record(`m${index}`)), groups: {}, activeCount: 10, pendingCount: 0 });
});
afterEach(cleanup);

describe("记忆地图", () => {
  it("says the sentence the picture proves, with the number that needs a look as a button, and lists the same marks under the canvas", async () => {
    open();
    expect(await screen.findByText(/EviMed 记住了你的 10 件事/u)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1 件，只看这些" })).toBeInTheDocument();
    const list = await screen.findByRole("list", { name: "标记" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("有研究称该药把再入院减半");
    expect(rows[0]).toHaveTextContent("依据的资料已撤回");
    expect(rows).toHaveLength(12);
    expect(screen.getByRole("img", { name: /共 \d+ 个标记/u })).toBeInTheDocument();
  });

  it("asks the server once for the project, range and focus, and the other four views switch over the document in hand", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByText(/EviMed 记住了你的/u);
    expect(fetchMemoryMap).toHaveBeenCalledTimes(1);
    expect(fetchMemoryMap.mock.calls[0][0]).toEqual({ projectId: null, range: "all", focus: null, depth: 1 });
    for (const view of ["主题", "维度", "时间", "活跃", "关系"]) await user.click(viewChip(view));
    expect(fetchMemoryMap).toHaveBeenCalledTimes(1);
    expect(where()).toBe("/app/memory/map");
  });

  it("keeps the view, the narrowing and the open mark in the address: a view pushes, a filter replaces", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByText(/EviMed 记住了你的/u);
    await user.click(viewChip("维度"));
    expect(where()).toBe("/app/memory/map?view=dims");
    await user.click(screen.getByRole("button", { name: "只看需要看一眼的" }));
    expect(where()).toBe("/app/memory/map?view=dims&look=1");
    await user.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(where()).toBe("/app/memory/map?view=dims");
  });

  it("narrows to what needs a look from the number in the sentence, and the list follows", async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole("button", { name: "1 件，只看这些" }));
    expect(where()).toBe("/app/memory/map?look=1");
    const list = screen.getByRole("list", { name: "标记" });
    expect(within(list).getAllByRole("listitem").map((row) => row.textContent)).toEqual([expect.stringContaining("有研究称该药把再入院减半"), expect.stringContaining("GOLD 指南"), expect.stringContaining("10.1/x")]);
  });

  it("opens the memory page's own drawer from a row, and a document on its own page", async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole("button", { name: "有研究称该药把再入院减半" }));
    expect(where()).toContain("open=record%3Am3");
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    await waitFor(() => expect(fetchMemoryProfile).toHaveBeenCalled());
    expect(await within(dialog).findByText("记忆 m3")).toBeInTheDocument();
    await waitFor(() => expect(fetchRecordLinks).toHaveBeenCalledWith("m3"));
    await user.click(within(dialog).getByRole("button", { name: /关闭|close/iu }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("link", { name: "GOLD 指南" }));
    expect(await screen.findByText("资料页")).toBeInTheDocument();
  });

  it("opens an entity of the project's knowledge graph in the knowledge base's reader, and only narrows an unscoped map to it", async () => {
    const entity: MapNode = { id: "entity:trial-rocket-af", type: "entity", subtype: "trial", group: "trial", label: "ROCKET AF 试验", state: "current", open: null };
    const withEntity = (projectId: string | null) => {
      const doc = busyMap();
      return { ...doc, scope: { ...doc.scope, projectId }, nodes: [...doc.nodes, entity], edges: [...doc.edges, edge("entity:trial-rocket-af", "you:account")] };
    };
    const user = userEvent.setup();
    fetchMemoryMap.mockResolvedValue(withEntity("p1"));
    open("?project=p1");
    await user.click(await screen.findByRole("button", { name: "ROCKET AF 试验" }));
    expect(where()).toBe("/app/files/open?project=p1&tree=kg&path=entities%2Ftrial-rocket-af.md");
    cleanup();
    fetchMemoryMap.mockResolvedValue(withEntity(null));
    open();
    await user.click(await screen.findByRole("button", { name: "ROCKET AF 试验" }));
    expect(where()).toContain("focus=entity%3Atrial-rocket-af");
  });

  it("says a memory that is gone in a sentence, not as an empty drawer", async () => {
    fetchMemoryProfile.mockResolvedValue({ records: [], groups: {}, activeCount: 0, pendingCount: 0 });
    open("?open=record%3Anobody");
    expect(await screen.findByText(/这条记忆已经不在了/u)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("draws no graph when there is too little: the sentence, three numbers and the list", async () => {
    fetchMemoryMap.mockResolvedValue(busyMap({
      nodes: [memory("a"), memory("b")], edges: [], summary: { memories: 2, documents: 0, methods: 0, projects: 0, needsLook: 0, since: "2026-09-10" },
    }));
    open();
    expect(await screen.findByText(/EviMed 记住了你的 2 件事/u)).toBeInTheDocument();
    expect(screen.getByLabelText("三个数字")).toHaveTextContent("记忆2");
    expect(screen.getByText("再多聊几次，这里会长出你的地图。")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /关系图/u })).toBeNull();
    expect(within(screen.getByRole("list", { name: "标记" })).getAllByRole("listitem")).toHaveLength(2);
  });

  it("still draws a focus of a few marks: a picture of them is the point", async () => {
    fetchMemoryMap.mockResolvedValue(busyMap({
      scope: { projectId: null, range: { from: null, to: "2026-10-12", unit: "month" }, timeZone: "UTC", focus: "memory:m3", depth: 1 },
      nodes: busyMap().nodes.filter((node) => ["memory:m3", "document:src_1", "reference:doi:10.1/x"].includes(node.id)),
      edges: busyMap().edges.filter((entry) => entry.from === "memory:m3"),
    }));
    open("?focus=memory%3Am3");
    expect(await screen.findByRole("img", { name: /关系图/u })).toBeInTheDocument();
    expect(fetchMemoryMap.mock.calls[0][0]).toMatchObject({ focus: "memory:m3", depth: 1 });
    expect(screen.getByRole("button", { name: /聚焦：/u })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "来源链" })).toBeInTheDocument();
  });

  it("names what could not be read, and the rest of the map is still there", async () => {
    fetchMemoryMap.mockResolvedValue(busyMap({ missing: ["documents", "topics"] }));
    open();
    expect(await screen.findByText("有一部分没有读到：资料、主题。")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "标记" })).toBeInTheDocument();
  });

  it("says so when the map cannot be read at all, with a way to try again", async () => {
    fetchMemoryMap.mockRejectedValueOnce(new Error("down")).mockResolvedValue(busyMap());
    const user = userEvent.setup();
    open();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("暂时读不到记忆地图");
    await user.click(within(alert).getByRole("button", { name: /重试/u }));
    expect(await screen.findByText(/EviMed 记住了你的/u)).toBeInTheDocument();
  });

  it("says there is nothing yet when nothing is remembered", async () => {
    fetchMemoryMap.mockResolvedValue(busyMap({ nodes: [], edges: [], summary: { memories: 0, documents: 0, methods: 0, projects: 0, needsLook: 0, since: null } }));
    open();
    expect(await screen.findByText("还没有记住什么")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "标记" })).toBeNull();
  });

  it("asks for a regrouping once when the topics are out of date, and reads again when one was made", async () => {
    fetchMemoryMap.mockResolvedValueOnce(busyMap({ status: { topics: "stale" } })).mockResolvedValue(busyMap());
    refreshTopics.mockResolvedValue({ status: "ready", made: true });
    open("?view=topics");
    await waitFor(() => expect(refreshTopics).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(fetchMemoryMap).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("回答风格")).toBeInTheDocument();
    expect(refreshTopics).toHaveBeenCalledTimes(1);
  });

  it("is the last tab of 记忆胶囊: the memory page's own tab bar, 地图 selected, and the other four lead back to their lists", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByText(/EviMed 记住了你的/u);
    expect(screen.getByRole("heading", { name: "记忆胶囊" })).toBeInTheDocument();
    const tabs = screen.getByRole("tablist", { name: "记忆" });
    expect(within(tabs).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["关于你", "项目", "做法", "地图"]);
    expect(within(tabs).getByRole("tab", { name: "地图" })).toHaveAttribute("aria-selected", "true");
    await user.click(within(tabs).getByRole("tab", { name: "做法" }));
    expect(where()).toBe("/app/memory?tab=methods");
    expect(await screen.findByText("记忆页")).toBeInTheDocument();
  });

  // R19 (plan §3 S10; audit D C1c): the page held to the framework's assertions, on each of its five views.
  describe("composed as a data page of the framework", () => {
    it.each(["graph", "topics", "dims", "time", "activity"])("%s: the tabs of 记忆胶囊 are the one row of views, the views and the filters are one toolbar under them, and the sentence comes before the picture", async (view) => {
      const { container } = open(view === "graph" ? "" : `?view=${view}`);
      const sentence = await screen.findByText(/EviMed 记住了你的/u);
      const facts = expectComposed(container, { tablists: 1, toolbar: true });
      // One row of tabs (the page's own four), one toolbar — and the five views are chips in it, not a second row of tabs or radios.
      expect(facts.toolbars).toHaveLength(1);
      expect(screen.queryByRole("radiogroup")).toBeNull();
      expect(facts.toolbars[0]).toContainElement(screen.getByRole("group", { name: "地图的视图" }));
      expect(facts.chrome!.contains(facts.toolbars[0]!)).toBe(true);
      expect(facts.chrome!.contains(facts.tablists[0]!)).toBe(true);
      // The sentence is the page's headline slot, under the band; the picture and its list are the body.
      const headline = container.querySelector("[data-headline]")!;
      expect(headline).toContainElement(sentence);
      expect(precedes(facts.chrome!, headline)).toBe(true);
      expect(precedes(headline, facts.body!.firstElementChild!)).toBe(true);
      expect(facts.body!.contains(headline)).toBe(false);
      // Nothing that filters stands in the body.
      expect([...facts.body!.querySelectorAll("input[type=search]")]).toEqual([]);
    });

    it("is the same column as the lists of 记忆胶囊, so the title and the tabs do not move between them", async () => {
      const { container } = open();
      await screen.findByText(/EviMed 记住了你的/u);
      expect(container.querySelector("[data-page-header]")!.parentElement).toHaveClass("max-w-page");
      expect(container.querySelector("[data-page-header]")!.parentElement).not.toHaveClass("max-w-wide");
    });

    it("keeps the project in the header, as the scope of the page, and not among the filters", async () => {
      useProjectStore.setState({ projects: [{ id: "p1", name: "疳证 Meta" }, { id: "p2", name: "信尔美" }], currentId: "p1" });
      open();
      await screen.findByText(/EviMed 记住了你的/u);
      const header = document.querySelector("[data-page-header]") as HTMLElement;
      expect(within(header).getByRole("button", { name: "项目" })).toHaveTextContent("全部项目");
      expect(within(document.querySelector("[data-toolbar]") as HTMLElement).queryByRole("button", { name: /^项目/ })).toBeNull();
      await userEvent.click(within(header).getByRole("button", { name: "项目" }));
      await userEvent.click(await screen.findByRole("menuitemradio", { name: "信尔美" }));
      expect(where()).toBe("/app/memory/map?project=p2");
    });

    it("has the legend in the card and the replay in the card's header — the controls of a chart belong to the chart", async () => {
      const dated = busyMap();
      dated.nodes = dated.nodes.map((node, index) => (node.type === "memory" ? { ...node, at: `2026-09-${String(10 + index).padStart(2, "0")}T00:00:00.000Z` } : node));
      fetchMemoryMap.mockResolvedValue(dated);
      open();
      const replay = await screen.findByRole("slider", { name: "回放到哪一天" });
      const card = replay.closest("section")!;
      expect(card.querySelector("header")).toContainElement(replay);
      expect(within(card).getByRole("button", { name: "回放它是怎么长出来的" })).toBeInTheDocument();
      expect(card).toContainElement(screen.getByRole("group", { name: "图例" }));
      // The card's heading says what is in it, with its numbers; the legend is under the heading, over the picture.
      const heading = within(card).getByRole("heading", { level: 2 });
      expect(heading.textContent).toMatch(/^\d+ 件现行的记忆/u);
      expect(precedes(heading, screen.getByRole("group", { name: "图例" }))).toBe(true);
      expect(precedes(screen.getByRole("group", { name: "图例" }), card.querySelector("[data-chart]")!)).toBe(true);
      // Nothing under the picture says how to use the replay or what the colours are.
      expect(document.body.textContent).not.toMatch(/拖下面的滑块/u);
    });

    it("has one entry for the time window on each view: the menu everywhere but 时间, where it is the bars' slider and a window that is set lets go from the toolbar", async () => {
      open();
      await screen.findByText(/EviMed 记住了你的/u);
      // The 时间 chip of the views is one button; the menu of the window, which says 「全部时间」, is the other — the two are not one name.
      const windowMenus = (toolbar: HTMLElement) => within(toolbar).queryAllByRole("button", { name: /^全部时间|^近 / }).filter((button) => button.getAttribute("aria-haspopup") === "menu");
      expect(windowMenus(document.querySelector("[data-toolbar]") as HTMLElement)).toHaveLength(1);
      cleanup();
      fetchMemoryMap.mockResolvedValue(busyMap({ scope: { projectId: null, range: { from: "2026-09-01", to: "2026-09-30", unit: "week" }, timeZone: "Asia/Shanghai", focus: null, depth: null } }));
      open("?view=time&range=2026-09-01..2026-09-30");
      await screen.findByText(/EviMed 记住了你的/u);
      const toolbar = document.querySelector("[data-toolbar]") as HTMLElement;
      // No 时间 menu (it would be a second entry); the window is a mark that lets go of it.
      expect(windowMenus(toolbar)).toHaveLength(0);
      await userEvent.click(within(toolbar).getByRole("button", { name: /^时间：2026-09-01 至 2026-09-30/u }));
      expect(where()).toBe("/app/memory/map?view=time");
    });
  });
});
