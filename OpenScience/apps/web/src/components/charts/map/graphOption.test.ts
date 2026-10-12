import { describe, expect, it } from "vitest";
import type { MapEdge, MapNode } from "@/lib/memoryMapClient";
import { LAYOUT_SIZE, layoutGraph, unitHash } from "./layout";
import { TEST_PALETTE } from "./palette";
import { chainOption, edgeTooltip, graphOption, symbolOf, tooltipOf } from "./graphOption";

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
    expect(first.get("you:account")).toEqual([LAYOUT_SIZE / 2, LAYOUT_SIZE / 2]);
    for (const [x, y] of first.values()) { expect(x).toBeGreaterThanOrEqual(20); expect(x).toBeLessThanOrEqual(LAYOUT_SIZE - 20); expect(y).toBeGreaterThanOrEqual(20); expect(y).toBeLessThanOrEqual(LAYOUT_SIZE - 20); }
  });
  it("keeps a mark where it is when more marks arrive that are not tied to it much", () => {
    expect(unitHash("a")).toBe(unitHash("a"));
    expect(unitHash("a")).not.toBe(unitHash("b"));
    expect(unitHash("a", 1)).not.toBe(unitHash("a", 2));
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

  it("holds the box with two invisible anchors, so the replay does not rescale the picture", () => {
    const anchors = series(graphOption(base) as any).data.filter((entry: any) => String(entry.name).startsWith("anchor:"));
    expect(anchors.map((entry: any) => [entry.x, entry.y])).toEqual([[0, 0], [LAYOUT_SIZE, LAYOUT_SIZE]]);
    expect(anchors.every((entry: any) => entry.symbolSize === 0 && entry.silent === true)).toBe(true);
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
    expect(html).toContain("决定 · 2026-09-20");
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
