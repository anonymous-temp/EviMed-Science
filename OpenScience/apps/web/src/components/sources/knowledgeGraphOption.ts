import type { EChartsCoreOption } from "echarts/core";
import { CHART_SERIES } from "@evimed/design-tokens";
import { escapeTooltip } from "@/components/charts/echartsBase";
import { graphOption } from "@/components/charts/map/graphOption";
import { layoutGraph } from "@/components/charts/map/layout";
import type { MapPalette } from "@/components/charts/map/palette";
import type { MapEdge, MapNode } from "@/lib/memoryMapClient";
import type { ColorScheme } from "@/lib/colorScheme";
import type { KnowledgeTreeName } from "@/lib/sourceClient";
import { foldId, hueOfTypes, type FoldedType, type GraphLine, type GraphMark } from "./knowledgeGraph";

/**
 * The knowledge graph, as the library is asked to draw it — the memory map's picture (`graphOption`, `layoutGraph`), told
 * about pages and entities instead of memories.
 *
 * A page is a square and an entity a circle; each kind of mark has a hub, a hollow hexagon named for the kind, with its marks
 * laid round it, the most connected nearest. The three kinds with the most marks carry a hue (the chart palette's blue,
 * teal and violet), every other kind is grey, and amber is reserved for what needs a look — a mark whose document changed.
 * A mark's size is its degree. A line is named by its relation on hover, and a folded part of a kind is one mark with its
 * count. Nothing here decides what is shown; `knowledgeGraph.ts` did.
 */

/** The chart palette's slots for the three coloured kinds: blue (the brand), teal, violet. */
const HUE_SLOTS = [0, 2, 3] as const;

export interface KnowledgeGraphInput {
  kind: KnowledgeTreeName;
  marks: readonly GraphMark[];
  lines: readonly GraphLine[];
  folded: readonly FoldedType[];
  hits: ReadonlySet<string>;
  /** The mark in focus. */
  focus: string | null;
  palette: MapPalette;
  scheme: ColorScheme;
  /** A canvas a phone's width: smaller marks and fewer labels. */
  compact?: boolean;
}

export interface KnowledgeGraphPlan {
  option: EChartsCoreOption;
  /** The ids of the series' data in order: a line's ends are indexes into it. */
  order: string[];
  /** The colour each kind of mark was given, for the legend; kinds without one are not in it. */
  hues: Map<string, string>;
}

const hubId = (type: string) => `project:${type}`;
export const isHub = (id: string) => id.startsWith("project:");

export function knowledgeGraphOption(input: KnowledgeGraphInput): KnowledgeGraphPlan {
  const { marks, lines, folded, palette, kind } = input;
  const hueOf = hueOfTypes(marks);
  const colours = new Map<string, string>([...hueOf].map(([type, index]) => [type, CHART_SERIES[input.scheme][HUE_SLOTS[index]!]!]));
  const neutral = palette.replaced;
  const maxDegree = Math.max(1, ...marks.map((mark) => mark.degree));
  const types = [...new Map([...marks.map((mark) => [mark.type, mark.typeLabel] as const), ...folded.map((fold) => [fold.type, fold.label] as const)])];

  const hubs: MapNode[] = types.map(([type, label]) => ({ id: hubId(type), type: "project", label, state: "current" }));
  const nodes: MapNode[] = marks.map((mark) => ({
    id: mark.id, type: kind === "kg" ? "entity" : "page", subtype: mark.type, group: mark.typeLabel, label: mark.title,
    weight: mark.degree / maxDegree, state: mark.stale.length > 0 ? "check" : "current", reason: mark.stale.length > 0 ? "source-changed" : null,
    description: mark.description, projectId: mark.type,
  }));
  const clusters: MapNode[] = folded.map((fold) => ({
    id: foldId(fold.type), type: "cluster", subtype: fold.type, group: fold.label, label: `${fold.count} 个${fold.label}`, count: fold.count,
    memberType: kind === "kg" ? "entity" : "page", state: "current", projectId: fold.type,
  }));
  const all = [...hubs, ...nodes, ...clusters];
  const edges: MapEdge[] = lines.map((line) => (kind === "kg" && line.label
    ? { from: line.from, to: line.to, type: "relates", label: line.label }
    : { from: line.from, to: line.to, type: "links" }));

  const positions = layoutGraph(all.map((node) => ({
    id: node.id, type: node.type, home: node.type === "project" ? null : node.projectId ?? null, weight: node.type === "project" ? 1 : node.weight ?? 0.2,
  })), edges);
  const base = graphOption({ nodes: all, edges, positions, hits: input.hits, selected: input.focus, palette, labelBudget: 0, compact: input.compact }) as {
    tooltip: Record<string, unknown>; series: Array<{ data: Array<Record<string, any>>; links: Array<Record<string, any>> }>;
  };

  const byId = new Map(marks.map((mark) => [mark.id, mark]));
  const labelled = new Set([...marks].sort((left, right) => right.degree - left.degree || left.id.localeCompare(right.id))
    .slice(0, marks.length <= 30 ? marks.length : input.compact ? 4 : 12).map((mark) => mark.id));
  const colourOf = (type: string) => colours.get(type) ?? neutral;
  const [series] = base.series;
  series!.data = series!.data.map((item) => {
    const id = String(item.name);
    const mark = byId.get(id);
    if (mark) {
      const colour = mark.stale.length > 0 ? palette.check : colourOf(mark.type);
      const size = (input.compact ? 7 : 9) + 17 * Math.sqrt(mark.degree / maxDegree) + (id === input.focus ? 4 : 0);
      return {
        ...item, symbolSize: size,
        itemStyle: { ...item.itemStyle, color: colour },
        label: { ...item.label, show: labelled.has(id) || input.hits.has(id) || id === input.focus },
      };
    }
    if (isHub(id)) {
      const type = id.slice("project:".length);
      return { ...item, itemStyle: { ...item.itemStyle, borderColor: colourOf(type) }, label: { ...item.label, color: colourOf(type) === neutral ? palette.text : palette.text } };
    }
    return item;
  });
  // A relation is named when the line is hovered, not drawn along every line: the list of relations would be a hairball of words.
  series!.links = series!.links.map((link) => ({ ...link, label: { show: false }, emphasis: { label: { show: true } } }));

  const labelOf = new Map(all.map((node) => [node.id, node]));
  base.tooltip.formatter = (params: { dataType?: string; name?: string; data?: { tooltipText?: string } }) => {
    if (params.dataType === "edge") return params.data?.tooltipText ?? "";
    const id = String(params.name);
    const mark = byId.get(id);
    if (mark) {
      const extra = [`${mark.typeLabel}`, mark.degree > 0 ? `${mark.degree} 条连线` : ""].filter(Boolean).join(" · ");
      const gist = mark.description.length > 90 ? `${mark.description.slice(0, 89)}…` : mark.description;
      return [
        `<div style="max-width:280px;white-space:normal"><strong>${escapeTooltip(mark.title)}</strong></div>`,
        `<div>${escapeTooltip(extra)}</div>`,
        ...(gist ? [`<div style="max-width:280px;white-space:normal">${escapeTooltip(gist)}</div>`] : []),
        ...(mark.stale.length > 0 ? ["<div>依据的资料有变化</div>"] : []),
      ].join("");
    }
    const node = labelOf.get(id);
    if (!node) return "";
    if (node.type === "cluster") return `<div>${escapeTooltip(node.label)}，点一下展开</div>`;
    return `<div><strong>${escapeTooltip(node.label)}</strong></div>`;
  };

  return { option: base as unknown as EChartsCoreOption, order: all.map((node) => node.id), hues: colours };
}
