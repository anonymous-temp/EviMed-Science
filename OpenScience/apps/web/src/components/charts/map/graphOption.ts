import type { EChartsCoreOption } from "echarts/core";
import type { MapEdge, MapNode, MapReason } from "@/lib/memoryMapClient";
import { REASON_TEXT, groupWord, markKindWord } from "@/components/memory/map/mapModel";
import { escapeTooltip } from "../echartsBase";
import { LAYOUT_HEIGHT, LAYOUT_WIDTH } from "./layout";
import type { MapPalette } from "./palette";

/**
 * The relation graph, as the library is asked to draw it.
 *
 * What a mark is told by (spec §2, the colour budget): its **state** by colour — the brand blue in force, amber for a second
 * look, grey replaced — its **kind** by shape and by its words in the tooltip and the list, never by another hue. The account and
 * the projects are hollow hexagons (blue outline, the page's own surface inside), a memory a circle, a decision or a correction a
 * diamond, a document or a knowledge page a square, a learned method a triangle, an outside source a rounded square, a concept of
 * the knowledge base a ring, and a folded cluster a hexagon with its size. Positions come from `layout.ts`, so the same marks give the same picture; the library only draws and lets the
 * reader zoom, pan and drag.
 *
 * Labels are a budget, not a rule: the account, the projects, the clusters, whatever needs a look, the hits of a search, the
 * mark in focus and the few that weigh most — at most two of them to a project, so a hub that holds most of what is remembered does
 * not spend the whole budget on one corner of the picture. Every other mark is named when pointed at, and in full: a label on the
 * canvas is cut short, the hover and the selected mark say all of it. Where two labels would still cover each other the library
 * hides the one of the smaller mark (`labelLayout.hideOverlap`, which needs the `LabelLayout` feature registered — `register.ts`).
 */

const HEXAGON = "path://M50,0 L93,25 L93,75 L50,100 L7,75 L7,25 Z";

export interface GraphInput {
  nodes: readonly MapNode[];
  edges: readonly MapEdge[];
  positions: ReadonlyMap<string, readonly [number, number]>;
  /** The marks a search matched; the others are dimmed while any are. */
  hits: ReadonlySet<string>;
  /** The mark in focus or open in the drawer. */
  selected: string | null;
  palette: MapPalette;
  /** How many of the marks tied to the most carry a label of their own (6 by default, none on a phone), at most `LABELS_PER_HUB` of one project. */
  labelBudget?: number;
  /** A canvas a phone's width: the same picture in smaller marks, with a label for the structure and what needs a look only. */
  compact?: boolean;
}

/** The most marks of one project (or of the account itself) that are named without being pointed at. */
export const LABELS_PER_HUB = 2;
/** The longest a name is on the canvas; the hover, the selection and the list say it whole. */
const CANVAS_LABEL_CHARS = 14;

/**
 * How much room, in the layout's units, a name needs beside its mark and, centred above or below, on each side of it. The picture is
 * fitted to the canvas, so a name of the same length is more of the layout on a phone's width than on a desk's.
 */
const ROOM_BESIDE = { desk: 260, phone: 420 };
const ROOM_CENTRED = { desk: 100, phone: 210 };
/** And above or below it: a name may run to a few lines when it is pointed at. */
const ROOM_LINES = { desk: 90, phone: 150 };

/** The extent the picture is fitted to: the marks' own, with a margin. */
export function fittedBox(positions: Iterable<readonly [number, number]>, margin = 50): [number, number, number, number] {
  const every = [...positions];
  return every.length === 0 ? [0, 0, LAYOUT_WIDTH, LAYOUT_HEIGHT]
    : [Math.min(...every.map(([x]) => x)) - margin, Math.min(...every.map(([, y]) => y)) - margin, Math.max(...every.map(([x]) => x)) + margin, Math.max(...every.map(([, y]) => y)) + margin];
}

/**
 * Where a mark's name stands: away from the hub it hangs from, so it neither covers the hub nor the marks between the two, and
 * never towards an edge of the picture it would run off — then the other way across, and, last, the side that has the room. A mark
 * with no hub of its own hangs from the account in the middle. `box` is the extent the picture is fitted to (`fittedBox`): the
 * canvas ends there, whatever the layout's own size is.
 */
export function labelPosition(at: readonly [number, number], hub: readonly [number, number] | undefined, { compact = false, box = [0, 0, LAYOUT_WIDTH, LAYOUT_HEIGHT] as readonly number[] } = {}): "left" | "right" | "top" | "bottom" {
  const [x, y] = at;
  const [left, top, right, bottom] = box;
  const beside = compact ? ROOM_BESIDE.phone : ROOM_BESIDE.desk;
  const centred = compact ? ROOM_CENTRED.phone : ROOM_CENTRED.desk;
  const lines = compact ? ROOM_LINES.phone : ROOM_LINES.desk;
  const [hubX, hubY] = hub ?? [LAYOUT_WIDTH / 2, LAYOUT_HEIGHT / 2];
  const dx = x - hubX;
  const dy = y - hubY;
  const horizontal = dx >= 0 ? "right" : "left";
  const vertical = dy >= 0 ? "bottom" : "top";
  const across = (side: string) => (side === "right" ? "left" : side === "left" ? "right" : side === "top" ? "bottom" : "top");
  const room = (side: string) => (side === "right" ? right - x >= beside : side === "left" ? x - left >= beside
    : x - left >= centred && right - x >= centred && (side === "bottom" ? bottom - y >= lines : y - top >= lines));
  // A mark lies more beside its hub than above or below it when the run is the longer, with a little allowance for a wide name.
  const order = Math.abs(dx) * 0.7 >= Math.abs(dy) ? [horizontal, vertical, across(horizontal)] : [vertical, horizontal, across(vertical)];
  const chosen = order.find(room);
  return (chosen ?? (x - left < right - x ? "right" : "left")) as "left" | "right" | "top" | "bottom";
}

/** The shape of a mark and its size, in the library's pixels. */
export function symbolOf(node: MapNode): { symbol: string; size: number } {
  const weight = node.weight ?? 0;
  switch (node.type) {
    case "you": return { symbol: HEXAGON, size: 38 };
    case "project": return { symbol: HEXAGON, size: 30 };
    case "cluster": return { symbol: HEXAGON, size: Math.min(46, 20 + Math.sqrt(node.count ?? 1) * 3.5) };
    case "document": return { symbol: "rect", size: 13 };
    case "reference": return { symbol: "roundRect", size: 12 };
    case "method": return { symbol: "triangle", size: 14 };
    case "entity": return { symbol: "circle", size: 14 };
    case "page": return { symbol: "rect", size: 12 };
    default: return { symbol: node.subtype === "decision" || node.subtype === "correction" ? "diamond" : "circle", size: 8 + weight * 8 };
  }
}

/** The colour of a mark's state. */
function colourOf(node: MapNode, palette: MapPalette): string {
  return node.state === "check" ? palette.check : node.state === "replaced" ? palette.replaced : palette.current;
}

/** The words of a mark's tooltip: what it is, its date, why it needs a look. Every user word is escaped. */
export function tooltipOf(node: MapNode, formatDay: (iso: string | null | undefined) => string = (iso) => (iso ? iso.slice(0, 10) : "")): string {
  const day = formatDay(node.at);
  const why = node.state === "check" ? REASON_TEXT[node.reason as MapReason] ?? "需要看一眼" : node.state === "replaced" ? "已被后来的说法替代" : "";
  return [
    `<div style="max-width:260px;white-space:normal"><strong>${escapeTooltip(node.label)}</strong></div>`,
    `<div>${escapeTooltip([markKindWord(node), day].filter(Boolean).join(" · "))}</div>`,
    ...(why ? [`<div>${escapeTooltip(why)}</div>`] : []),
  ].join("");
}

const EDGE_WORDS: Record<MapEdge["type"], string> = {
  "belongs-to": "属于", "rests-on": "依据", replaces: "替代了", conflicts: "彼此矛盾", links: "链接到", quotes: "引自", relates: "相关",
};

/** A line in words: 「某条记忆 依据 某份资料」. */
export function edgeWords(edge: MapEdge, from: string, to: string): string {
  const word = edge.type === "relates" && edge.label ? edge.label : EDGE_WORDS[edge.type];
  return `${from} ${word} ${to}`;
}

/** Whether the researcher may call this line wrong: a derived line between two real marks. Structure, and the lines of a folded group, are not theirs to dismiss. */
export function isHideableEdge(edge: MapEdge, from: MapNode | undefined, to: MapNode | undefined): boolean {
  return Boolean(edge.id) && edge.type !== "belongs-to" && Boolean(from) && Boolean(to) && from?.type !== "cluster" && to?.type !== "cluster";
}

export function edgeTooltip(edge: MapEdge, from: string, to: string): string {
  return `<div style="max-width:280px;white-space:normal">${escapeTooltip(edgeWords(edge, from, to))}</div>`;
}

export function graphOption(input: GraphInput): EChartsCoreOption {
  const { palette } = input;
  const byId = new Map(input.nodes.map((node) => [node.id, node]));
  const searching = input.hits.size > 0;
  // The heaviest memories earn a label of their own; the rest are named on hover.
  const shrink = input.compact ? 0.5 : 1;
  // A label is a budget spent where the picture says something: on what is tied to something else (a source, a replaced version,
  // a disagreement, a concept's relations), by how many lines, then by weight — never on the marks that only belong to their hub,
  // which on a dense hub are most of them and would cover each other.
  const ties = new Map<string, number>();
  for (const edge of input.edges) {
    if (edge.type === "belongs-to") continue;
    ties.set(edge.from, (ties.get(edge.from) ?? 0) + 1);
    ties.set(edge.to, (ties.get(edge.to) ?? 0) + 1);
  }
  const budget = input.labelBudget ?? (input.compact ? 0 : 6);
  const perHub = new Map<string, number>();
  const heavy = new Set([...input.nodes].filter((node) => node.type === "memory" || node.type === "document" || node.type === "entity")
    // What was replaced is history, named when pointed at; what is current and tied to something is named now.
    .filter((node) => node.state !== "replaced" && ((ties.get(node.id) ?? 0) > 0 || (node.weight ?? 0) >= 0.8))
    .sort((left, right) => (ties.get(right.id) ?? 0) - (ties.get(left.id) ?? 0) || (right.weight ?? 0) - (left.weight ?? 0) || left.id.localeCompare(right.id))
    // The hub a mark hangs from is a budget of its own: the best of each project first, and no project more than `LABELS_PER_HUB`.
    .filter((node) => {
      const hub = node.projectId ?? "";
      const held = perHub.get(hub) ?? 0;
      if (held >= LABELS_PER_HUB) return false;
      perHub.set(hub, held + 1);
      return true;
    })
    .slice(0, budget).map((node) => node.id));
  // What needs a look is always worth a name — on a phone, the four of them tied to the most, since eight names in a hand's width are a smear.
  const looked = new Set([...input.nodes].filter((node) => node.state === "check")
    .sort((left, right) => (ties.get(right.id) ?? 0) - (ties.get(left.id) ?? 0) || (right.weight ?? 0) - (left.weight ?? 0) || left.id.localeCompare(right.id))
    .slice(0, input.compact ? 4 : Infinity).map((node) => node.id));
  // The marks that matter most come first — the structure, then what needs a look, is searched for or is chosen, then the heavy ones,
  // then the rest — which is the order they are drawn in (a later mark is on top). The lines point at these positions.
  const rank = (node: MapNode) => (node.type === "you" || node.type === "project" || node.type === "cluster" ? 0
    : node.state === "check" || input.hits.has(node.id) || input.selected === node.id ? 1 : heavy.has(node.id) ? 2 : 3);
  const ordered = input.nodes.map((node, position) => ({ node, position })).sort((left, right) => rank(left.node) - rank(right.node) || left.position - right.position).map((entry) => entry.node);
  const index = new Map(ordered.map((node, position) => [node.id, position]));

  // The picture is fitted to the marks' extent, and a name must not run past it.
  const box = fittedBox(input.positions.values());
  const data = ordered.map((node) => {
    const { symbol, size } = symbolOf(node);
    const structure = node.type === "you" || node.type === "project" || node.type === "cluster";
    // A concept out of the knowledge base is a ring where a memory is a dot: same circle, told apart by being hollow.
    const hollow = structure || node.type === "entity";
    const colour = colourOf(node, palette);
    const dimmed = searching && !input.hits.has(node.id) && !structure;
    const chosen = input.selected === node.id;
    const labelled = structure || looked.has(node.id) || chosen || input.hits.has(node.id) || heavy.has(node.id);
    const named = (full: boolean) => (node.type === "cluster" ? `${groupWord(node)}\n${node.count ?? 0}`
      : !full && [...node.label].length > CANVAS_LABEL_CHARS ? `${[...node.label].slice(0, CANVAS_LABEL_CHARS - 1).join("")}…` : node.label);
    const [x, y] = input.positions.get(node.id) ?? [LAYOUT_WIDTH / 2, LAYOUT_HEIGHT / 2];
    return {
      name: node.id, x, y, symbol, symbolSize: Math.max(4, size * shrink),
      value: node.label,
      itemStyle: {
        // A hexagon of the structure is hollow: an outline in the state's colour on the page's own surface.
        color: hollow ? palette.surface : colour,
        borderColor: chosen ? palette.text : hollow ? colour : node.state === "check" ? palette.check : colour,
        borderWidth: chosen ? 3 : hollow ? 2 : node.type === "reference" ? 1.5 : 0,
        opacity: dimmed ? 0.22 : node.state === "replaced" ? 0.7 : 1,
      },
      label: {
        show: labelled,
        position: node.type === "you" ? "inside" : structure ? "bottom"
          : labelPosition([x, y], input.positions.get(node.projectId ? `project:${node.projectId}` : "you:account"), { compact: input.compact, box }),
        // The mark in front of the reader is named whole, over a few lines; the others are cut to a short name.
        formatter: named(chosen),
        ...(chosen && !structure ? { width: 200, overflow: "break" as const, lineHeight: 16 } : {}),
        color: palette.text,
        fontSize: input.compact ? 10 : structure ? 11 : 12,
        fontWeight: structure || node.state === "check" ? 600 : 400,
        distance: 6,
        // A label over a line or a neighbour stays legible on the page's own ground.
        backgroundColor: palette.surface, padding: [1, 3], borderRadius: 3,
      },
      // Pointed at, a mark says its whole name (over a few lines, so a long one does not run across the picture).
      emphasis: { label: { show: true, formatter: named(true), ...(structure ? {} : { width: 220, overflow: "break" as const, lineHeight: 16 }) } },
    };
  });

  // Two invisible anchors at the corners of the whole document's marks (not of what a replay or a narrowing shows) keep that extent,
  // and so the scale, the same while marks come and go.
  const anchors = [[box[0], box[1]], [box[2], box[3]]].map(([x, y], position) => ({
    name: `anchor:${position}`, x, y, symbolSize: 0, silent: true, label: { show: false }, itemStyle: { opacity: 0 }, tooltip: { show: false },
  }));

  const links = input.edges.filter((edge) => index.has(edge.from) && index.has(edge.to)).map((edge) => {
    const worried = edge.type === "conflicts" || (edge.type === "rests-on" && edge.state !== undefined && !["current", "unknown"].includes(edge.state));
    const dashed = edge.type === "replaces" ? "dashed" : edge.type === "conflicts" ? "dotted" : "solid";
    return {
      source: index.get(edge.from), target: index.get(edge.to),
      symbol: ["none", edge.type === "replaces" ? "arrow" : "none"], symbolSize: 7,
      lineStyle: {
        color: worried ? palette.check : palette.line, width: worried ? 1.6 : edge.type === "belongs-to" ? 0.7 : 1.1, type: dashed,
        opacity: edge.type === "belongs-to" ? 0.4 : 0.9, curveness: edge.type === "replaces" ? 0.18 : 0.04,
      },
      // A relation's name is on the line only for the mark the researcher is on (or pointing at): thirty relation names laid over thirty
      // lines were the picture. The tooltip of every line says it in words.
      label: { show: edge.type === "relates" && Boolean(edge.label) && (input.selected === edge.from || input.selected === edge.to), formatter: edge.label ?? "", color: palette.textFaint, fontSize: 11 },
      emphasis: { label: { show: edge.type === "relates" && Boolean(edge.label) } },
      tooltipText: edgeTooltip(edge, byId.get(edge.from)?.label ?? "", byId.get(edge.to)?.label ?? ""),
      // What a press on the line names, when the researcher may call it wrong.
      edgeId: isHideableEdge(edge, byId.get(edge.from), byId.get(edge.to)) ? edge.id : null,
    };
  });

  return {
    animation: false,
    tooltip: {
      confine: true,
      formatter: (params: { dataType?: string; name?: string; data?: { tooltipText?: string } }) => {
        if (params.dataType === "edge") return params.data?.tooltipText ?? "";
        const node = byId.get(String(params.name));
        return node ? tooltipOf(node) : "";
      },
    },
    series: [{
      type: "graph",
      layout: "none",
      // Fit inside the canvas without stretching circles, squares or hexagons.
      // ECharts compensates graph symbols with one scalar, so a stretched view distorts every mark.
      left: 12, right: 12, top: 12, bottom: 12,
      preserveAspect: "contain",
      roam: true,
      draggable: true,
      scaleLimit: { min: 0.4, max: 8 },
      data: [...data, ...anchors],
      links,
      labelLayout: { hideOverlap: true },
      edgeSymbol: ["none", "none"],
      emphasis: { focus: "adjacency", scale: 1.25, label: { show: true }, lineStyle: { width: 2 } },
      blur: { itemStyle: { opacity: 0.18 }, lineStyle: { opacity: 0.12 }, label: { opacity: 0.4 } },
    }],
  };
}

/** The source chain of one memory, as a tree to the right: the memory, what it rests on, and what it replaced. */
export interface ChainInput {
  root: MapNode;
  rests: ReadonlyArray<{ node: MapNode; state: MapEdge["state"] }>;
  replaced: readonly MapNode[];
  palette: MapPalette;
}

/** A name as a label carries it: cut at a length with an ellipsis. */
function clip(text: unknown, max: number): string {
  const chars = [...String(text ?? "")];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
}

const SOURCE_STATE_WORDS: Record<NonNullable<MapEdge["state"]>, string> = {
  current: "", changed: "有更新", retracted: "已撤回", expired: "已过期", unknown: "",
};

export function chainOption({ root, rests, replaced, palette }: ChainInput): EChartsCoreOption {
  const leaf = (node: MapNode, note: string, worried: boolean) => ({
    name: node.label, id: node.id,
    value: [markKindWord(node), note].filter(Boolean).join(" · "),
    symbol: node.type === "document" ? "rect" : node.type === "reference" ? "roundRect" : "circle", symbolSize: 12,
    itemStyle: { color: worried ? palette.check : node.state === "replaced" ? palette.replaced : palette.current, borderColor: worried ? palette.check : palette.line },
    label: { color: palette.text, fontWeight: worried ? 600 : 400 },
  });
  const children = [
    ...rests.map(({ node, state }) => leaf(node, SOURCE_STATE_WORDS[state ?? "unknown"], state === "retracted" || state === "changed" || state === "expired")),
    ...replaced.map((node) => leaf(node, "曾经如此", false)),
  ];
  return {
    animation: false,
    tooltip: {
      confine: true,
      formatter: (params: { name?: string; value?: string }) => `<div style="max-width:260px;white-space:normal"><strong>${escapeTooltip(params.name)}</strong></div><div>${escapeTooltip(params.value)}</div>`,
    },
    series: [{
      type: "tree", orient: "LR", layout: "orthogonal", roam: true, initialTreeDepth: 2, expandAndCollapse: false,
      top: "8%", bottom: "8%", left: "27%", right: "30%",
      symbolSize: 12,
      lineStyle: { color: palette.line, width: 1.2 },
      // The memory is named at its left in a line of its own length; each source is named at its right with what it is and what a check found.
      label: { position: "left", verticalAlign: "middle", align: "right", color: palette.text, fontSize: 12, formatter: (params: { name?: string }) => clip(params.name, 18) },
      leaves: { label: { position: "right", verticalAlign: "middle", align: "left", formatter: (params: { name?: string; value?: string }) => `${clip(params.name, 26)}${params.value ? `\n${params.value}` : ""}` } },
      data: [{
        name: root.label, id: root.id, value: markKindWord(root),
        itemStyle: { color: root.state === "check" ? palette.check : root.state === "replaced" ? palette.replaced : palette.current },
        children,
      }],
    }],
  };
}
