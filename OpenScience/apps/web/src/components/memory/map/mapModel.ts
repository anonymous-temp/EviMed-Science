import { kindTitle } from "@/lib/memoryGroups";
import type { MapEdge, MapNode, MapReason, MemoryMap } from "@/lib/memoryMapClient";
import type { MapSelection } from "./useMapSelection";

/**
 * What the five views draw, decided before any chart library is asked (the way `trendModel.ts` does for the trend line).
 *
 * Every function here is a plain function of the document and the selection: narrowing it, saying it in a sentence, listing its
 * marks, cutting it at a moment for the replay. Nothing touches a canvas, so all of it is tested without a browser — and the list
 * of marks under the canvas, which is what a screen reader meets, is built from the same function that tells the chart what to draw.
 */

/** The marks that are structure, not things the platform remembers: they are drawn, and never listed. */
export const STRUCTURE: ReadonlySet<string> = new Set(["you", "project"]);

/** What a mark that needs a second look says, in the reader's words. */
export const REASON_TEXT: Readonly<Record<MapReason, string>> = {
  "source-retracted": "依据的资料已撤回",
  "source-changed": "依据的资料有更新",
  "source-expired": "依据的资料已过期",
  conflict: "和另一条说法不一致",
  expired: "已过了有效期",
};

/** Fewer marks or lines than this and a picture says less than the list under it. */
export const MIN_NODES = 8;
export const MIN_EDGES = 5;

export interface NarrowedMap {
  nodes: MapNode[];
  edges: MapEdge[];
  /** The marks the search matched; empty when there is no search. */
  hits: ReadonlySet<string>;
  /** Whether a topic, kind, aspect or "needs a look" is narrowing the memories. */
  narrowed: boolean;
}

/** @param {string} text @param {string} query */
function matches(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase());
}

/**
 * The document narrowed by the selection's topic, kind, aspect, "needs a look" and search — all on the document in hand, so the
 * views switch at once.
 *
 * A narrowing is about memories: the memories that stay are the ones that match, and what is tied to them (their project, the
 * documents they rest on, what they replaced) stays with them. A mark nothing narrowed memory ties to — a method, an entity — is
 * there while nothing narrows and is gone while something does. A search does not remove anything from the picture, it names hits
 * (`hits`) for the picture to light up; the list under it shows the hits alone.
 */
export function narrowMap(doc: Pick<MemoryMap, "nodes" | "edges" | "facets">, selection: Pick<MapSelection, "topic" | "kind" | "dimension" | "look" | "q">): NarrowedMap {
  const axis = selection.dimension ? doc.facets.dimensions.flatMap((dimension) => dimension.axes).find((entry) => entry.id === selection.dimension) : undefined;
  const kinds = axis?.kinds ? new Set(axis.kinds) : null;
  const narrowed = Boolean(selection.topic || selection.kind || kinds || selection.look);
  let nodes = doc.nodes;
  let edges = doc.edges;
  if (narrowed) {
    const keep = (node: MapNode) => (
      (!selection.topic || (node.topics ?? []).includes(selection.topic))
      && (!selection.kind || node.subtype === selection.kind)
      && (!kinds || kinds.has(String(node.subtype)))
      && (!selection.look || node.state === "check")
    );
    const memories = new Set(doc.nodes.filter((node) => node.type === "memory" && keep(node)).map((node) => node.id));
    const tied = new Set<string>(memories);
    for (const edge of doc.edges) {
      if (edge.type === "belongs-to") continue;
      if (memories.has(edge.from)) tied.add(edge.to);
      if (memories.has(edge.to)) tied.add(edge.from);
    }
    for (const edge of doc.edges) {
      if (edge.type === "belongs-to" && memories.has(edge.from)) tied.add(edge.to);
    }
    nodes = doc.nodes.filter((node) => tied.has(node.id));
    const kept = new Set(nodes.map((node) => node.id));
    edges = doc.edges.filter((edge) => kept.has(edge.from) && kept.has(edge.to));
  }
  const query = selection.q.trim();
  const hits = query ? new Set(nodes.filter((node) => !STRUCTURE.has(node.type) && matches(`${node.label} ${node.description ?? ""}`, query)).map((node) => node.id)) : new Set<string>();
  return { nodes, edges, hits, narrowed };
}

export interface HeadlinePart {
  text: string;
  /** The part is a number that opens what it counts: it narrows the page to the marks that need a second look. */
  action?: "look";
}

/**
 * The sentence the picture proves, with its numbers (spec §5.5): 「EviMed 记住了你的 48 件事，其中 4 件依据的资料变了。」
 * The marks that need a look are told by what is most worth knowing — a source that changed, was withdrawn or expired — and
 * otherwise by their count; the number is a button.
 */
export function headline(doc: Pick<MemoryMap, "summary" | "nodes">): HeadlinePart[] {
  const { memories, needsLook } = doc.summary;
  if (memories === 0) return [{ text: "还没有记住什么。" }];
  const sources = doc.nodes.filter((node) => node.type === "memory" && node.state === "check" && String(node.reason ?? "").startsWith("source-")).length;
  const base = `EviMed 记住了你的 ${memories} 件事`;
  if (needsLook === 0) return [{ text: `${base}。` }];
  if (sources > 0 && sources >= needsLook / 2) return [{ text: `${base}，其中 ` }, { text: `${needsLook} 件`, action: "look" }, { text: "依据的资料变了或需要核对。" }];
  return [{ text: `${base}，其中 ` }, { text: `${needsLook} 件`, action: "look" }, { text: "需要看一眼。" }];
}

export function headlineText(parts: readonly HeadlinePart[]): string {
  return parts.map((part) => part.text).join("");
}

/** Whether the document has too little to draw as a graph: the headline, three numbers and the list say it better. */
export function isThin(doc: Pick<MemoryMap, "nodes" | "edges">): boolean {
  return doc.nodes.length < MIN_NODES || doc.edges.length < MIN_EDGES;
}

/**
 * What a group of marks is called: a kind of memory is called what the memory page calls it (`kindTitle`, the drawer's own title),
 * and anything else what its source called it.
 */
export function groupWord(node: Pick<MapNode, "type" | "subtype" | "group" | "memberType">): string {
  if ((node.type === "memory" || node.memberType === "memory") && node.subtype) return kindTitle(node.subtype);
  return node.group || node.subtype || "标记";
}

/** What kind of thing a mark is, in a word. */
export function markKindWord(node: MapNode): string {
  switch (node.type) {
    case "memory": return groupWord(node) || "记忆";
    case "document": return "资料";
    case "method": return "做法";
    case "cluster": return `${groupWord(node)}（${node.count ?? 0} 个）`;
    case "reference": return node.subtype === "doi" ? "论文" : node.subtype === "evidence_card" ? "证据卡" : "前沿动态";
    case "entity": return "实体";
    case "page": return "知识页";
    default: return "";
  }
}

export interface MarkRow {
  id: string;
  title: string;
  /** 「决定 · 3月2日」 and, when it needs a look or was replaced, why. */
  kind: string;
  note: string | null;
  state: "current" | "check" | "replaced";
  open: MapNode["open"] | null;
  node: MapNode;
}

const STATE_ORDER = { check: 0, current: 1, replaced: 2 } as const;

/**
 * The same marks as the picture, as a list — the page's text for a screen reader and for anything that cannot paint a canvas.
 * What needs a look comes first, then what is in force, then what was replaced; within each, the newest.
 * @param only when given, just these marks (a search's hits)
 */
export function markRows(nodes: readonly MapNode[], { only = null, formatDay }: { only?: ReadonlySet<string> | null; formatDay: (iso: string | null | undefined) => string }): MarkRow[] {
  return nodes
    .filter((node) => !STRUCTURE.has(node.type) && (!only || only.has(node.id)))
    .map((node): MarkRow => {
      const day = formatDay(node.at);
      const state = node.state ?? "current";
      return {
        id: node.id, title: node.label, kind: [markKindWord(node), day].filter(Boolean).join(" · "),
        note: state === "check" ? REASON_TEXT[node.reason as MapReason] ?? "需要看一眼" : state === "replaced" ? "已被后来的说法替代" : null,
        state, open: node.open ?? null, node,
      };
    })
    .sort((left, right) => STATE_ORDER[left.state] - STATE_ORDER[right.state]
      || String(right.node.at ?? "").localeCompare(String(left.node.at ?? "")) || left.id.localeCompare(right.id));
}

/** The moments the replay stops at: each distinct time something began, oldest first. */
export function replayStops(nodes: readonly MapNode[]): string[] {
  return [...new Set(nodes.filter((node) => !STRUCTURE.has(node.type) && node.at).map((node) => node.at as string))].sort();
}

/**
 * The marks that existed at a moment, and the lines between them. The account and its projects are always there; a mark with no
 * time (an entity from a compile) is there from the start.
 */
export function existingAt<T extends { nodes: readonly MapNode[]; edges: readonly MapEdge[] }>(map: T, moment: string | null): { nodes: MapNode[]; edges: MapEdge[] } {
  if (!moment) return { nodes: [...map.nodes], edges: [...map.edges] };
  const nodes = map.nodes.filter((node) => STRUCTURE.has(node.type) || !node.at || node.at <= moment);
  const there = new Set(nodes.map((node) => node.id));
  return { nodes, edges: map.edges.filter((edge) => there.has(edge.from) && there.has(edge.to)) };
}
