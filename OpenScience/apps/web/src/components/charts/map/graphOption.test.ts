import { describe, expect, it } from "vitest";
import type { MapEdge, MapNode } from "@/lib/memoryMapClient";
import { LAYOUT_HEIGHT, LAYOUT_WIDTH, layoutGraph, unitHash } from "./layout";
import { TEST_PALETTE } from "./palette";
import { chainOption, edgeTooltip, edgeWords, graphOption, isHideableEdge, symbolOf, tooltipOf } from "./graphOption";

const memory = (id: string, over: Partial<MapNode> = {}): MapNode => ({ id: `memory:${id}`, type: "memory", subtype: "preference", group: "偏好", label: `记忆 ${id}`, weight: 0.4, state: "current", ...over });
const you: MapNode = { id: "you:account", type: "you", label: "你", state: "current" };
const project: MapNode = { id: "project:p", type: "project", label: "心衰随访", state: "current", projectId: "p" };

const nodes: MapNode[] = [
  you, project, memory("a"), memory("b", { subtype: "decision", state: "check", reason: "source-retracted", projectId: "p" }), memory("c", { state: "replaced" }),
  { id: "document:src_1", type: "document", label: "GOLD", group: "指南", state: "current" },
  { id: "cluster:memory:p:preference", type: "cluster", label: "偏好", group: "偏好", count: 40, state: "current" },
];
const edges: MapEdge[] = [
  { from: "memory:a", to: "you:account", type: "belongs-to" },
  { from: "memory:b", to: "project:p", type: "belongs-to" },
  { from: "memory:b", to: "document:src_1", type: "rests-on", state: "retracted" },
  { from: "memory:a", to: "document:src_1", type: "rests-on", state: "current" },
  { from: "memory:a", to: "memory:c", type: "replaces" },
  { from: "memory:a", to: "memory:b", type: "conflicts" },
];
const positions = layoutGraph(nodes.map((node) => ({ id: node.id, type: node.type, home: node.projectId ?? null, weight: node.weight ?? 0 })), edges);

describe("the layout", () => {
  it("is the same every time for the same marks, wherever they come in the list", () => {
    const layout = (list: MapNode[]) => layoutGraph(list.map((node) => ({ id: node.id, type: node.type, home: node.projectId ?? null, weight: 0 })), edges);
    const first = layout(nodes);
    const second = layout([...nodes].reverse());
    expect([...first.entries()].sort()).toEqual([...second.entries()].sort());
    expect(first.get("you:account")).toEqual([LAYOUT_WIDTH / 2, LAYOUT_HEIGHT / 2]);
    for (const [x, y] of first.values()) { expect(x).toBeGreaterThanOrEqual(20); expect(x).toBeLessThanOrEqual(LAYOUT_WIDTH - 20); expect(y).toBeGreaterThanOrEqual(20); expect(y).toBeLessThanOrEqual(LAYOUT_HEIGHT - 20); }
  });
  it("keeps a mark where it is when more marks arrive that are not tied to it much", () => {
    expect(unitHash("a")).toBe(unitHash("a"));
    expect(unitHash("a")).not.toBe(unitHash("b"));
    expect(unitHash("a", 1)).not.toBe(unitHash("a", 2));
  });
  it("lays a hub's marks round it, the heaviest nearest, and never two on one spot", () => {
    const crowd = [you, project, ...Array.from({ length: 30 }, (_, index) => memory(`m${index}`, { projectId: "p", weight: index / 30 }))];
    const at = layoutGraph(crowd.map((node) => ({ id: node.id, type: node.type, home: node.projectId ?? null, weight: node.weight ?? 0 })), []);
    const hub = at.get("project:p") as [number, number];
    const distance = (id: string) => Math.hypot((at.get(id) as number[])[0] - hub[0], (at.get(id) as number[])[1] - hub[1]);
    expect(distance("memory:m29")).toBeLessThan(distance("memory:m0"));
    const spots = new Set([...at.values()].map(([x, y]) => `${Math.round(x / 8)}:${Math.round(y / 8)}`));
    expect(spots.size).toBe(at.size);
  });
  it("stands a document beside the marks that rest on it, and sets what is tied to nothing on the outer ring", () => {
    const withDocs = [you, project, memory("a", { projectId: "p" }), memory("b", { projectId: "p" }),
      { id: "document:d", type: "document", label: "d" } as MapNode, { id: "entity:lonely", type: "entity", label: "e" } as MapNode];
    const at = layoutGraph(withDocs.map((node) => ({ id: node.id, type: node.type, home: node.projectId ?? null, weight: 0 })), [
      { from: "memory:a", to: "document:d" }, { from: "memory:b", to: "document:d" },
    ]);
    const a = at.get("memory:a") as number[];
    const doc = at.get("document:d") as number[];
    expect(Math.hypot(a[0] - doc[0], a[1] - doc[1])).toBeLessThan(200);
    const lonely = at.get("entity:lonely") as number[];
    expect(Math.hypot(lonely[0] - LAYOUT_WIDTH / 2, lonely[1] - LAYOUT_HEIGHT / 2)).toBeGreaterThan(300);
  });
  it("handles a map with a single mark, and none", () => {
    expect(layoutGraph([], []).size).toBe(0);
    expect(layoutGraph([{ id: "memory:x", type: "memory", home: null, weight: 0 }], []).get("memory:x")).toBeDefined();
  });
});

describe("the graph option", () => {
  const series = (option: any) => option.series[0];
  const base = { nodes, edges, positions, hits: new Set<string>(), selected: null, palette: TEST_PALETTE };

  it("tells a mark's state by colour and its kind by shape: three hues, and the structure hollow", () => {
    const option: any = graphOption(base);
    const byName = Object.fromEntries(series(option).data.map((entry: any) => [entry.name, entry]));
    expect(byName["memory:a"].itemStyle.color).toBe("#blue");
    expect(byName["memory:b"].itemStyle.color).toBe("#amber");
    expect(byName["memory:c"].itemStyle.color).toBe("#grey");
    expect(byName["memory:a"].symbol).toBe("circle");
    expect(byName["memory:b"].symbol).toBe("diamond");
    expect(byName["document:src_1"].symbol).toBe("rect");
    expect(byName["you:account"].itemStyle.color).toBe("#surface");
    expect(byName["you:account"].itemStyle.borderColor).toBe("#blue");
    const colours = new Set(series(option).data.flatMap((entry: any) => [entry.itemStyle?.color, entry.itemStyle?.borderColor]).filter(Boolean));
    expect([...colours].every((colour) => ["#blue", "#amber", "#grey", "#surface", "#text"].includes(colour as string))).toBe(true);
  });

  it("labels the structure, what needs a look, the selected, the hits and the few that weigh most", () => {
    const heavy = [memory("h1", { weight: 0.9 }), memory("h2", { weight: 0.8 }), ...Array.from({ length: 20 }, (_, index) => memory(`l${index}`, { weight: 0.1 }))];
    const crowd = [...nodes, ...heavy];
    const option: any = graphOption({ ...base, nodes: crowd, positions: layoutGraph(crowd.map((node) => ({ id: node.id, type: node.type, home: null, weight: 0 })), []), selected: "memory:l3", hits: new Set(["memory:l5"]), labelBudget: 2 });
    const shown = series(option).data.filter((entry: any) => entry.label?.show).map((entry: any) => entry.name).sort();
    expect(shown).toEqual(["cluster:memory:p:preference", "memory:b", "memory:h1", "memory:h2", "memory:l3", "memory:l5", "project:p", "you:account"].sort());
    expect(series(option).labelLayout.hideOverlap).toBe(true);
  });

  it("dims what a search did not match, and rings the selected mark", () => {
    const option: any = graphOption({ ...base, hits: new Set(["memory:a"]), selected: "memory:a" });
    const byName = Object.fromEntries(series(option).data.map((entry: any) => [entry.name, entry]));
    expect(byName["memory:b"].itemStyle.opacity).toBeLessThan(0.5);
    expect(byName["memory:a"].itemStyle.opacity).toBe(1);
    expect(byName["memory:a"].itemStyle.borderWidth).toBe(3);
    expect(byName["you:account"].itemStyle.opacity).toBe(1);
  });

  it("draws a withdrawn source and a disagreement in amber, a replacement dashed with an arrow, and links by index", () => {
    const option: any = graphOption(base);
    const links = series(option).links;
    expect(links).toHaveLength(edges.length);
    const index = (id: string) => nodes.findIndex((node) => node.id === id);
    const link = (from: string, to: string) => links.find((entry: any) => entry.source === index(from) && entry.target === index(to));
    expect(link("memory:b", "document:src_1").lineStyle.color).toBe("#amber");
    expect(link("memory:a", "document:src_1").lineStyle.color).toBe("#line");
    expect(link("memory:a", "memory:c").lineStyle.type).toBe("dashed");
    expect(link("memory:a", "memory:c").symbol).toEqual(["none", "arrow"]);
    expect(link("memory:a", "memory:b").lineStyle.type).toBe("dotted");
    expect(series(option).layout).toBe("none");
  });

  it("holds the extent with two invisible anchors round every mark of the document, so a replay does not rescale the picture", () => {
    const anchors = series(graphOption(base) as any).data.filter((entry: any) => String(entry.name).startsWith("anchor:"));
    const xs = [...positions.values()].map(([x]) => x);
    const ys = [...positions.values()].map(([, y]) => y);
    expect(anchors.map((entry: any) => [entry.x, entry.y])).toEqual([[Math.min(...xs) - 50, Math.min(...ys) - 50], [Math.max(...xs) + 50, Math.max(...ys) + 50]]);
    const replayed = series(graphOption({ ...base, nodes: nodes.slice(0, 3) }) as any).data.filter((entry: any) => String(entry.name).startsWith("anchor:"));
    expect(replayed.map((entry: any) => [entry.x, entry.y])).toEqual(anchors.map((entry: any) => [entry.x, entry.y]));
    expect(anchors.every((entry: any) => entry.symbolSize === 0 && entry.silent === true)).toBe(true);
  });

  it("draws the same marks smaller on a phone, and names only the structure and what needs a look", () => {
    const wide: any = graphOption({ ...base, labelBudget: 3 });
    const small: any = graphOption({ ...base, compact: true });
    const size = (option: any, name: string) => series(option).data.find((entry: any) => entry.name === name).symbolSize;
    expect(size(small, "memory:a")).toBeLessThan(size(wide, "memory:a"));
    expect(size(small, "project:p")).toBe(size(wide, "project:p") / 2);
    const labelled = (option: any) => series(option).data.filter((entry: any) => entry.label?.show).map((entry: any) => entry.name).sort();
    expect(labelled(small)).toEqual(["cluster:memory:p:preference", "memory:b", "project:p", "you:account"]);
    expect(series(small).data.length).toBe(series(wide).data.length);
  });

  it("sizes a memory by its weight and a cluster by how many it stands for", () => {
    expect(symbolOf(memory("x", { weight: 1 })).size).toBeGreaterThan(symbolOf(memory("y", { weight: 0 })).size);
    expect(symbolOf({ id: "cluster:a", type: "cluster", label: "x", count: 100 }).size).toBeGreaterThan(symbolOf({ id: "cluster:b", type: "cluster", label: "x", count: 4 }).size);
  });
});

describe("what the tooltip says, escaped", () => {
  it("never lets a memory's words become markup", () => {
    const hostile = memory("x", { label: `<img src=x onerror="alert(1)"> & "q"` });
    const html = tooltipOf(hostile);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &quot;q&quot;");
    expect(edgeTooltip({ from: "a", to: "b", type: "relates", label: "<b>x</b>" }, "<i>a</i>", "b")).not.toContain("<i>");
  });
  it("says why a mark needs a look, and what it is", () => {
    const html = tooltipOf(memory("b", { state: "check", reason: "conflict", group: "决定", at: "2026-09-20T00:00:00.000Z" }));
    expect(html).toContain("和另一条说法不一致");
    expect(html).toContain("偏好 · 2026-09-20");
  });
});

describe("the source chain", () => {
  it("is the memory, what it rests on with the state a check found, and what it replaced", () => {
    const option: any = chainOption({
      root: memory("b", { state: "check" }),
      rests: [
        { node: { id: "reference:doi:10.1/x", type: "reference", subtype: "doi", label: "10.1/x", state: "current" }, state: "retracted" },
        { node: { id: "document:src_1", type: "document", label: "GOLD", group: "指南", state: "current" }, state: "current" },
      ],
      replaced: [memory("old", { state: "replaced" })], palette: TEST_PALETTE,
    });
    const root = option.series[0].data[0];
    expect(root.children.map((child: any) => [child.id, child.value])).toEqual([
      ["reference:doi:10.1/x", "论文 · 已撤回"], ["document:src_1", "资料"], ["memory:old", "偏好 · 曾经如此"],
    ]);
    expect(root.children[0].itemStyle.color).toBe("#amber");
    expect(root.children[2].itemStyle.color).toBe("#grey");
    expect(option.series[0].orient).toBe("LR");
  });
});

describe("a line the researcher may call wrong", () => {
  const lines: MapEdge[] = [
    { id: "e_aaaaaaaaaaaaaaaaaaaaaaaa", from: "memory:b", to: "document:src_1", type: "rests-on", state: "retracted" },
    { id: "e_bbbbbbbbbbbbbbbbbbbbbbbb", from: "memory:a", to: "you:account", type: "belongs-to" },
    { id: "e_cccccccccccccccccccccccc", from: "memory:a", to: "cluster:memory:p:preference", type: "rests-on" },
    { from: "memory:a", to: "memory:c", type: "replaces" },
  ];
  const by = new Map(nodes.map((node) => [node.id, node]));

  it("is a derived line between two real marks that has an id; structure, a folded group's line and a line without an id are not", () => {
    expect(lines.map((line) => isHideableEdge(line, by.get(line.from), by.get(line.to)))).toEqual([true, false, false, false]);
  });

  it("is named on the line the library draws, so a press on the canvas can say which one it was", () => {
    const option = graphOption({ nodes, edges: lines, positions, hits: new Set(), selected: null, palette: TEST_PALETTE }) as { series: Array<{ links: Array<{ edgeId: string | null }> }> };
    expect(option.series[0].links.map((link) => link.edgeId)).toEqual(["e_aaaaaaaaaaaaaaaaaaaaaaaa", null, null, null]);
  });

  it("is said in words with the marks' own names", () => {
    expect(edgeWords(lines[0], "有研究称该药把再入院减半", "GOLD")).toBe("有研究称该药把再入院减半 依据 GOLD");
    expect(edgeWords({ from: "entity:a", to: "entity:b", type: "relates", label: "治疗" }, "二甲双胍", "2 型糖尿病")).toBe("二甲双胍 治疗 2 型糖尿病");
  });
});
