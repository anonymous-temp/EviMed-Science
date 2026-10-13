import { describe, expect, it } from "vitest";
import { CHART_SERIES } from "@evimed/design-tokens";
import { TEST_PALETTE } from "@/components/charts/map/palette";
import type { KnowledgeGraph } from "@/lib/sourceClient";
import kgMedical from "./knowledgeFixtures/graph-kg-medical.json";
import wikiMixed from "./knowledgeFixtures/graph-wiki-mixed.json";
import { modelOf, overview } from "./knowledgeGraph";
import { isHub, knowledgeGraphOption } from "./knowledgeGraphOption";

type Data = { name: string; symbol: string; symbolSize: number; itemStyle: { color: string; borderColor?: string }; label: { show: boolean } };
type Link = { source: number; target: number; label: { show: boolean }; emphasis: { label: { show: boolean } }; tooltipText?: string };
type Built = { series: Array<{ data: Data[]; links: Link[] }>; tooltip: { formatter: (params: object) => string } };

function build(graph: unknown, patch: object = {}) {
  const model = modelOf(graph as KnowledgeGraph);
  const view = overview(model);
  const plan = knowledgeGraphOption({ kind: model.kind, marks: view.marks, lines: view.lines, folded: view.folded, hits: new Set(), focus: null, palette: TEST_PALETTE, scheme: "light", ...patch });
  const option = plan.option as unknown as Built;
  return { plan, option, data: option.series[0]!.data, links: option.series[0]!.links, model };
}

describe("knowledgeGraphOption", () => {
  it("gives every kind a hub and every mark a place in the series, in the order the plan says", () => {
    const { plan, data, model } = build(kgMedical);
    const named = data.filter((item) => !item.name.startsWith("anchor:")).map((item) => item.name);
    expect(named).toEqual(plan.order);
    expect(plan.order.filter(isHub)).toHaveLength(new Set(model.marks.map((mark) => mark.type)).size);
    expect(plan.order.filter((id) => !isHub(id))).toHaveLength(model.marks.length);
  });

  it("colours the three biggest kinds, leaves the rest grey, and keeps amber for a mark whose document changed", () => {
    const { plan, data } = build(kgMedical);
    expect([...plan.hues.values()]).toEqual([CHART_SERIES.light[0], CHART_SERIES.light[2], CHART_SERIES.light[3]]);
    const grey = data.filter((item) => !isHub(item.name) && !item.name.startsWith("anchor:") && item.itemStyle.color === TEST_PALETTE.replaced);
    expect(grey.length).toBe(2);
    const stale = build({ ...kgMedical, nodes: (kgMedical as { nodes: object[] }).nodes.map((node, index) => (index === 0 ? { ...node, stale: [{ sourceId: "src_x", reason: "changed" }] } : node)) });
    expect(stale.data.filter((item) => item.itemStyle.color === TEST_PALETTE.check)).toHaveLength(1);
  });

  it("sizes a mark by its degree and names a relation on hover, not along the line", () => {
    const { data, links, model } = build(kgMedical);
    const sizeOf = (id: string) => data.find((item) => item.name === id)!.symbolSize;
    const most = [...model.marks].sort((left, right) => right.degree - left.degree)[0]!;
    const least = [...model.marks].sort((left, right) => left.degree - right.degree)[0]!;
    expect(sizeOf(most.id)).toBeGreaterThan(sizeOf(least.id));
    expect(links.length).toBe(model.lines.length);
    expect(links.every((link) => link.label.show === false && link.emphasis.label.show === true)).toBe(true);
    expect(links.some((link) => /实现|纳入|研究|评估|结局|药物/u.test(link.tooltipText ?? ""))).toBe(true);
  });

  it("draws a page as a square and an entity as a circle", () => {
    expect(build(wikiMixed).data.find((item) => !isHub(item.name) && !item.name.startsWith("anchor:"))!.symbol).toBe("rect");
    expect(build(kgMedical).data.find((item) => !isHub(item.name) && !item.name.startsWith("anchor:"))!.symbol).toBe("circle");
  });

  it("labels what the reader is looking for", () => {
    const first = (kgMedical as { nodes: Array<{ id: string }> }).nodes[0]!.id;
    const { data } = build(kgMedical, { hits: new Set([first]), focus: first });
    expect(data.find((item) => item.name === first)!.label.show).toBe(true);
  });

  it("escapes a title in the tooltip", () => {
    const graph = { kind: "kg", nodes: [{ id: "a", path: "p", title: "<img src=x onerror=alert(1)>", entityType: "x", description: "", degree: 1, sourceId: "s", stale: [], sources: [] }], links: [], unresolved: 0, problems: [] };
    const { option } = build(graph);
    const html = option.tooltip.formatter({ name: "a", dataType: "node" });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
