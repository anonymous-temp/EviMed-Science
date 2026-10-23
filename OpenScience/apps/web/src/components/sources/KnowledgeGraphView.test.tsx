import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "@/lib/projects";
import type { KnowledgeGraph } from "@/lib/sourceClient";
import type { KnowledgeListState } from "@/lib/knowledgeNav";
import kgMedical from "./knowledgeFixtures/graph-kg-medical.json";
import wikiMedical from "./knowledgeFixtures/graph-wiki-medical.json";
import { KnowledgeGraphView } from "./KnowledgeGraphView";

const mocks = vi.hoisted(() => ({ graph: vi.fn(), exportImage: vi.fn(() => "data:image/png;base64,AA=="), chart: { current: null as null | { on: { click: (params: object) => void }; option: { series: Array<{ links: Array<{ source: number; target: number }> }> } | null } } }));
vi.mock("@/lib/sourceClient", async (importOriginal) => ({ ...(await importOriginal<object>()), getKnowledgeGraph: mocks.graph }));
// The canvas cannot be painted here; the chart's option and the events it forwards are what the page hands it.
vi.mock("@/components/charts/MapChart", () => ({
  MapChart: (props: { on: { click: (params: object) => void }; option: { series: Array<{ links: Array<{ source: number; target: number }> }> } | null; label: string; chart?: { current: unknown } }) => {
    if (props.chart) props.chart.current = { getDataURL: mocks.exportImage };
    mocks.chart.current = props;
    return <div role="img" aria-label={props.label} />;
  },
}));

const selectSpy = vi.fn(async (_projectId: string, land?: () => void) => { land?.(); });
function Where() { const location = useLocation(); return <><p data-testid="where">{location.pathname}{location.search}{JSON.stringify((location.state as { runtimeUiIntent?: { references?: unknown } } | null)?.runtimeUiIntent?.references ?? null)}</p><pre data-testid="draft">{(location.state as { runtimeUiIntent?: { draft?: string } } | null)?.runtimeUiIntent?.draft}</pre></>; }

const base: KnowledgeListState = { scope: null, kind: "wiki", q: "", view: "graph", graph: "kg" };
function view(state: Partial<KnowledgeListState> = {}, onChange = vi.fn(), kind: "wiki" | "kg" = "kg") {
  render(
    <MemoryRouter initialEntries={["/app/files?kind=wiki&view=graph&graph=kg"]}>
      <Routes>
        <Route path="/app/files" element={<KnowledgeGraphView projectId="p1" kind={kind} listState={{ ...base, ...state }} version="1" onChange={onChange} empty={<p>还没有整理出页面的配方</p>} />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
  return onChange;
}
const kgNodes = (kgMedical as unknown as KnowledgeGraph).nodes;
const rocket = kgNodes.find((node) => node.id === "trial-rocket-af")!;

describe("KnowledgeGraphView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.graph.mockImplementation(async (_project: string, kind: string) => (kind === "kg" ? kgMedical : wikiMedical));
    useProjectStore.setState({ select: selectSpy as never });
  });
  afterEach(cleanup);

  it("lists the entities, the most connected first, each opening its file in the reader, and names the three coloured kinds", async () => {
    view();
    const list = await screen.findByRole("list", { name: "实体" });
    const links = within(list).getAllByRole("link");
    expect(links[0]).toHaveAttribute("href", expect.stringMatching(/^\/app\/files\/src_[a-f0-9]{32}\?kind=wiki&view=graph&graph=kg$/));
    const degrees = within(list).getAllByText(/^\d+ 条连线$/).map((node) => Number(node.textContent!.split(" ")[0]));
    expect(degrees).toEqual([...degrees].sort((left, right) => right - left));
    const legend = screen.getByRole("group", { name: "图例" });
    expect(legend).toHaveTextContent("药物");
    expect(legend).toHaveTextContent("试验");
    expect(legend).toHaveTextContent("结局");
    expect(legend).toHaveTextContent("其他");
    expect(mocks.graph).toHaveBeenCalledWith("p1", "kg");
  });

  it("names a quiet line when relations could not be drawn, and says nothing of the engine", async () => {
    view();
    expect(await screen.findByText(/有 1 处连线没能画出来，不影响其余的内容/)).toBeInTheDocument();
  });

  it("provides keyboard zoom, full view and overview reset without another pane", async () => {
    view();
    await screen.findByRole("list", { name: "实体" });
    const controls = screen.getByRole("group", { name: "图谱视图" });
    await userEvent.click(within(controls).getByRole("button", { name: "放大图谱" }));
    expect(mocks.chart.current!.option!.series[0]).toHaveProperty("zoom", 1.25);
    await userEvent.click(within(controls).getByRole("button", { name: "完整视图" }));
    expect(within(controls).getByRole("button", { name: "收起视图" })).toBeInTheDocument();
    await userEvent.click(within(controls).getByRole("button", { name: "回到全图" }));
    expect(mocks.chart.current!.option!.series[0]).toHaveProperty("zoom", 1);
  });

  it("removes project A links before a delayed or failed project B load", async () => {
    let rejectB: (reason: Error) => void = () => undefined;
    mocks.graph.mockImplementation((id: string) => id === "A" ? Promise.resolve(kgMedical) : new Promise((_resolve, reject) => { rejectB = reject; }));
    const props = { kind: "kg" as const, listState: base, version: "1", onChange: vi.fn(), empty: <p>Empty</p> };
    const content = (projectId: string) => <MemoryRouter><KnowledgeGraphView {...props} projectId={projectId} /></MemoryRouter>;
    const rendered = render(content("A"));
    await screen.findByRole("list", { name: "实体" });
    rendered.rerender(content("B"));
    expect(screen.queryByRole("list", { name: "实体" })).toBeNull();
    await act(async () => { rejectB(new Error("B unavailable")); });
    expect(await screen.findByText(/无法画出图谱/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: rocket.title })).toBeNull();
  });

  it("exports the currently displayed graph with its project scope", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function(this: HTMLAnchorElement) {
      expect(this.download).toBe("entities-p1.png");
      expect(this.href).toBe("data:image/png;base64,AA==");
    });
    view();
    await screen.findByRole("list", { name: "实体" });
    await userEvent.click(screen.getByRole("button", { name: "导出图片" }));
    expect(mocks.exportImage).toHaveBeenCalledWith({ type: "png", pixelRatio: 2 });
    expect(click).toHaveBeenCalledOnce();
    click.mockRestore();
  });

  it("lets a keyboard select a relationship and prepares its supplied evidence without inventing missing passages", async () => {
    const sourceId = `src_${"a".repeat(32)}`;
    const unavailableId = `src_${"b".repeat(32)}`;
    const node = (id: string) => ({ id, title: id, path: id, degree: 1, sourceId: null, description: "", sources: [], stale: [] });
    mocks.graph.mockResolvedValue({ kind: "kg", nodes: [node("Alpha"), node("Beta")], links: [{ source: "Alpha", target: "Beta", label: "supports", evidence: [
      { sourceId, title: "Trial paper", sourceVersion: 4, locator: { page: 7, sheet: "Results", cell: "B4" }, quote: "The exact supplied evidence.", available: true },
      { sourceId: unavailableId, title: "Earlier paper", sourceVersion: 2, available: false },
    ] }], unresolved: 0, problems: [] });
    view();
    const relationship = await screen.findByRole("button", { name: "Alpha supports Beta" });
    relationship.focus();
    await userEvent.keyboard("{Enter}");
    const evidence = await screen.findByRole("region", { name: "连线的依据" });
    expect(evidence).toHaveTextContent("Trial paper");
    await userEvent.click(within(evidence).getByRole("button", { name: "在对话中使用这条关系" }));
    const draft = await screen.findByTestId("draft");
    expect(draft).toHaveTextContent("Trial paper · 第 4 版");
    expect(draft).toHaveTextContent("第 7 页");
    expect(draft).toHaveTextContent("Results · B4");
    expect(draft).toHaveTextContent("The exact supplied evidence.");
    expect(draft).toHaveTextContent("Earlier paper · 第 2 版 · 当前不可读取 · 未提供原文位置 · 未提供引文");
    expect(screen.getByTestId("where")).toHaveTextContent(JSON.stringify([{ id: sourceId, title: "Trial paper" }]));
  });

  it("carries the evidence passage and source version from a canvas edge into the draft", async () => {
    const sourceId = `src_${"c".repeat(32)}`;
    const graph = kgMedical as unknown as KnowledgeGraph;
    mocks.graph.mockResolvedValue({ ...graph, links: graph.links.map((entry) => ({ ...entry, evidence: [{ sourceId, title: "Versioned trial", sourceVersion: 8, quote: "Preserved trial passage", locator: { page: 11 } }] })) });
    view();
    await screen.findByRole("list", { name: "实体" });
    const link = mocks.chart.current!.option!.series[0]!.links[0]!;
    act(() => { mocks.chart.current!.on.click({ dataType: "edge", data: { source: link.source, target: link.target } }); });
    await userEvent.click(within(await screen.findByRole("region", { name: "连线的依据" })).getByRole("button", { name: "在对话中使用这条关系" }));
    expect(await screen.findByTestId("draft")).toHaveTextContent("Versioned trial · 第 8 版 · 第 11 页");
    expect(screen.getByTestId("draft")).toHaveTextContent("Preserved trial passage");
  });

  it("shows the hits of the search alone in the list", async () => {
    view({ q: "ROCKET" });
    const list = await screen.findByRole("list", { name: "搜索命中的标记" });
    const titles = within(list).getAllByRole("link").map((link) => link.textContent);
    expect(titles.length).toBeGreaterThan(0);
    expect(titles.every((title) => /ROCKET/iu.test(String(title)) || kgNodes.some((node) => node.title === title && /rocket/iu.test(`${node.description} ${(node.aliases ?? []).join(" ")}`)))).toBe(true);
  });

  it("shows an empty result for an active query with no matches", async () => {
    view({ q: "a phrase absent from the graph" });
    expect(await screen.findByText("没有找到相关标记")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "搜索命中的标记" })).queryAllByRole("link")).toHaveLength(0);
  });

  it("takes a mark into focus from its menu, shows its neighbourhood with a depth, and lets the focus go", async () => {
    const onChange = view();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: `“${rocket.title}”的操作` }));
    await user.click(await screen.findByRole("menuitem", { name: "聚焦在这里" }));
    expect(onChange).toHaveBeenCalledWith({ focus: "trial-rocket-af", depth: 2 });
    cleanup();
    const second = view({ focus: "trial-rocket-af", depth: 1 });
    const bar = await screen.findByRole("group", { name: "聚焦" });
    expect(bar).toHaveTextContent(rocket.title);
    const around = within(screen.getByRole("list", { name: "实体" })).getAllByRole("link").length;
    expect(around).toBeLessThan(kgNodes.length);
    expect(around).toBeGreaterThan(1);
    const slider = within(bar).getByRole("slider", { name: "聚焦范围，几步以内" });
    expect(slider).toHaveValue("1");
    fireEvent.change(slider, { target: { value: "2" } });
    expect(second).toHaveBeenCalledWith({ depth: 2 });
    await user.click(within(bar).getByRole("button", { name: "取消聚焦" }));
    expect(second).toHaveBeenCalledWith({ focus: null, depth: null });
  });

  it("takes a mark and the documents it cites into a conversation", async () => {
    view();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: `“${rocket.title}”的操作` }));
    await user.click(await screen.findByRole("menuitem", { name: "在对话中使用" }));
    await waitFor(() => expect(selectSpy).toHaveBeenCalledWith("p1", expect.any(Function)));
    const where = screen.getByTestId("where").textContent!;
    expect(where.startsWith("/app/chat")).toBe(true);
    const references = JSON.parse(where.slice("/app/chat".length)) as Array<{ id: string; title: string }>;
    expect(references[0]).toEqual({ id: rocket.sourceId, title: rocket.title });
    expect(references.slice(1).map((entry) => entry.id)).toEqual(rocket.sources.map((entry) => entry.sourceId).filter((id) => id !== rocket.sourceId));
  });

  it("opens the documents a line was read from when a line is pressed", async () => {
    view();
    await screen.findByRole("list", { name: "实体" });
    const link = mocks.chart.current!.option!.series[0]!.links[0]!;
    act(() => { mocks.chart.current!.on.click({ dataType: "edge", data: { source: link.source, target: link.target } }); });
    const panel = await screen.findByRole("region", { name: "连线的依据" });
    expect(within(panel).getByText("依据的资料：")).toBeInTheDocument();
    expect(within(panel).getAllByRole("link").length).toBeGreaterThan(0);
    expect(within(panel).getByRole("button", { name: "在对话中使用这条关系" })).toBeInTheDocument();
    await userEvent.setup().click(within(panel).getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("region", { name: "连线的依据" })).toBeNull();
  });

  it("opens a mark's file when the mark is pressed on the picture", async () => {
    view();
    await screen.findByRole("list", { name: "实体" });
    act(() => { mocks.chart.current!.on.click({ dataType: "node", name: "trial-rocket-af" }); });
    await waitFor(() => expect(screen.getByTestId("where").textContent).toContain(`/app/files/${rocket.sourceId}`));
  });

  it("reads the pages graph as pages and their links", async () => {
    view({ graph: null }, vi.fn(), "wiki");
    const list = await screen.findByRole("list", { name: "页面" });
    expect(within(list).getAllByRole("link")).toHaveLength(19);
    expect(screen.getByRole("group", { name: "图例" })).toHaveTextContent("■ 页面");
  });

  it("holds a big graph to the overview and unfolds a kind when asked", async () => {
    const nodes = Array.from({ length: 220 }, (_, index) => ({ id: `n${index}`, path: `entities/n${index}.md`, title: `实体${index}`, entityType: index % 2 ? "drug" : "trial", description: "", degree: 1, sourceId: `src_${String(index).padStart(32, "0")}`, stale: [], sources: [] }));
    const links = nodes.slice(1).map((node, index) => ({ source: node.id, target: `n${index}`, relation: "next", label: "下一个", evidence: [] }));
    mocks.graph.mockResolvedValue({ kind: "kg", nodes, links, relations: [], unresolved: 0, problems: [] });
    view();
    const folded = await screen.findByText(/另有 70 个标记折叠在各自的类里/);
    expect(folded).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^展开 \d+ 个/ })).toHaveLength(2);
    await userEvent.setup().click(screen.getAllByRole("button", { name: /^展开 \d+ 个/ })[0]!);
    // The kind that was unfolded is whole; what is still folded is the other kind.
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^展开 \d+ 个/ })).toHaveLength(1));
  });

  it("draws the picture as a card whose heading counts what is in it, with the legend and the quiet line in the card", async () => {
    view();
    const heading = await screen.findByRole("heading", { level: 2, name: /^\d+ 个实体，\d+ 条关系$/u });
    const card = heading.closest("section")!;
    expect(within(card).getByRole("img", { name: /实体和关系的关系图/u })).toBeInTheDocument();
    expect(within(card).getByRole("group", { name: "图例" })).toBeInTheDocument();
    // The list under the picture is outside the card: it is the same marks as text.
    expect(card).not.toContainElement(screen.getByRole("list", { name: "实体" }));
  });

  it("is the list alone when the graph is too thin to draw, hands an empty graph to the page's recipe, and offers a retry when it cannot be read", async () => {
    mocks.graph.mockResolvedValue({ kind: "kg", nodes: kgNodes.slice(0, 2), links: [], relations: [], unresolved: 0, problems: [] });
    view();
    expect(await screen.findByRole("list", { name: "实体" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /关系图/u })).toBeNull();
    expect(screen.queryByText(/内容还少/u)).toBeNull();
    cleanup();
    mocks.graph.mockResolvedValue({ kind: "kg", nodes: [], links: [], relations: [], unresolved: 0, problems: [] });
    view();
    expect(await screen.findByText("还没有整理出页面的配方")).toBeInTheDocument();
    cleanup();
    mocks.graph.mockRejectedValueOnce(new Error("down")).mockResolvedValue(kgMedical);
    view();
    await userEvent.setup().click(await screen.findByRole("button", { name: "重试" }));
    expect(await screen.findByRole("list", { name: "实体" })).toBeInTheDocument();
  });
});
