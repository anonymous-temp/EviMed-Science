import type { RingCell, RingLink, RingSegment, RingSpec } from "@/components/charts/ring/ringModel";
import type { MapEdge, MapEvent, MapNode } from "@/lib/memoryMapClient";
import { brightnessOf, familyOf, isRecentlyRecalled, STAR_FAMILIES, STAR_FAMILY_ORDER, type StarFamily } from "./starModel";

/**
 * 记忆星环: a person's memory as a ring (owner, 2026-11-26), the ring's parts in the memory's words. Plain functions of the map's document,
 * so the picture, its full-screen panels and the list a keyboard walks are all decided without a browser.
 *
 * What each thing says: a cell is one thing remembered, standing in its kind's segment (or its project's) in the order it was written; its
 * length is how much it weighs, its brightness how lately it was written or used, grey what was replaced; the cloud inside a segment is its
 * cells' own light; a line is a relation the document holds (replaces, conflicts, rests on, relates) and light travels along it; a spark
 * flies from the centre to a memory a conversation was handed in the last three days, and to one the moment it is written or recalled while
 * the page is open. Nothing moves that does not say one of these.
 */

export type RingBy = "kind" | "project";

/** A kind's colour, as a `--star-*` token: the eight hues are the kinds' and nowhere else does a kind have one. */
export const FAMILY_TONE: Readonly<Record<StarFamily, string>> = {
  person: "entity", note: "document", about: "about", preference: "preference", correction: "correction", fact: "fact", decision: "decision", method: "method", document: "document", entity: "entity",
};

/** The short code beside a kind's word round the ring. */
const FAMILY_CODE: Readonly<Record<StarFamily, string>> = {
  person: "PEOPLE", note: "NOTES", about: "ABOUT", preference: "PREFS", correction: "FIXES", fact: "FACTS", decision: "DECIDE", method: "METHODS", document: "SOURCES", entity: "CONCEPTS",
};

const LINE_TONE: Readonly<Partial<Record<MapEdge["type"], string>>> = { replaces: "line-replaces", conflicts: "line-conflicts", "rests-on": "line-rests" };
const LINE_STRENGTH: Readonly<Partial<Record<MapEdge["type"], number>>> = { replaces: 0.85, conflicts: 0.85, "rests-on": 0.42 };
const PERSONAL = "project:none";

/** How far a cell reaches, by what it is: a heavy memory is long, a concept short. */
function lengthOf(node: MapNode): number {
  const weight = Math.max(0, Math.min(1, node.weight ?? 0.4));
  if (node.type === "cluster") return 0.95;
  if (node.state === "replaced") return 0.15;
  if (node.type === "entity") return 0.2;
  if (node.type === "document" || node.type === "page" || node.type === "reference") return 0.38;
  return 0.25 + 0.75 * weight;
}

const timeOf = (at: string | null | undefined): number | null => {
  const ms = Date.parse(at ?? "");
  return Number.isFinite(ms) ? ms : null;
};

/** The marks of the ring: everything the person's memory holds that has a kind (the account and its projects are structure, not cells). */
export function ringMarks(nodes: readonly MapNode[]): MapNode[] {
  return nodes.filter((node) => familyOf(node) !== null);
}

/**
 * The ring of a memory map. By kind, a segment for each kind it holds, in the legend's one order; by project, a segment for each project
 * that holds something and one for what belongs to none, in the order the document lists them, each cell keeping its kind's colour.
 */
export function memoryRingSpec(nodes: readonly MapNode[], edges: readonly MapEdge[], { by, now }: { by: RingBy; now: number }): RingSpec {
  const marks = ringMarks(nodes);
  const segmentOf = (node: MapNode): string => {
    if (by === "kind") return familyOf(node) as StarFamily;
    return node.projectId && nodes.some((other) => other.id === `project:${node.projectId}`) ? `project:${node.projectId}` : PERSONAL;
  };
  const used = new Set(marks.map(segmentOf));
  const segments: RingSegment[] = by === "kind"
    ? STAR_FAMILY_ORDER.filter((family) => used.has(family)).map((family) => ({ id: family, label: STAR_FAMILIES[family].word, code: FAMILY_CODE[family], tone: FAMILY_TONE[family] }))
    : [
      ...nodes.filter((node) => node.type === "project" && used.has(node.id)).map((node) => ({ id: node.id, label: node.label, tone: "hub" })),
      ...(used.has(PERSONAL) ? [{ id: PERSONAL, label: "不属于项目", tone: "you" }] : []),
    ];
  const cells: RingCell[] = marks.map((node) => {
    const at = timeOf(node.at);
    return {
      id: node.id, segment: segmentOf(node), order: at ?? 0, at, length: lengthOf(node), bright: brightnessOf(node), tone: FAMILY_TONE[familyOf(node) as StarFamily],
      state: node.state === "replaced" ? "replaced" : "current", spark: isRecentlyRecalled(node, now),
    };
  });
  const held = new Set(cells.map((cell) => cell.id));
  const links: RingLink[] = edges
    .filter((edge) => edge.type !== "belongs-to" && held.has(edge.from) && held.has(edge.to) && edge.from !== edge.to)
    .map((edge, index) => ({
      id: edge.id ?? `${edge.type}:${edge.from}>${edge.to}#${index}`, from: edge.from, to: edge.to, tone: LINE_TONE[edge.type] ?? "line-relates",
      strength: LINE_STRENGTH[edge.type] ?? 0.3, flow: edge.type !== "conflicts",
    }));
  const you = nodes.find((node) => node.type === "you");
  // A sparse memory gets more light a cell, so its clouds read; a large one fewer, so they do not merge.
  const particlesPerCell = cells.length > 120 ? 4 : cells.length > 60 ? 6 : 8;
  return { segments, cells, clusters: [], links, particlesPerCell, centre: { label: you?.label ?? "你", tone: "you" } };
}

// ---------------------------------------------------------------------------------------------------- the full-screen panels

/** What happened to a memory, in a word. */
const VERB: Readonly<Record<string, string>> = { created: "记下", learned: "学会", restored: "找回", superseded: "替代", archived: "忘记", retired: "停用", updated: "更新", confirmed: "确认" };

export interface RingLogEntry {
  /** A stable key: the event's id, or the recall's mark. */
  key: string;
  at: number;
  verb: string;
  /** The kind's word and colour, or none for a memory no longer in the picture. */
  word: string;
  tone: string;
  text: string;
  /** The cell it happened to, while the picture holds it. */
  cell: string | null;
}

/**
 * The memory's log, newest first: each event the document carries (written, learned, brought back, replaced, forgotten, updated, confirmed)
 * and each memory's last recall. A recall is the last one only — the document keeps no earlier ones — so the log says when a memory was
 * last handed to a conversation, never how often.
 */
export function ringLog(nodes: readonly MapNode[], events: readonly MapEvent[], now: number, limit = Infinity): RingLogEntry[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const out: RingLogEntry[] = [];
  const describe = (node: MapNode | undefined) => {
    const family = node ? familyOf(node) : null;
    return family ? { word: STAR_FAMILIES[family].word, tone: FAMILY_TONE[family] } : { word: "记忆", tone: "hub" };
  };
  for (const event of events) {
    const verb = VERB[event.change];
    const at = timeOf(event.at);
    if (!verb || at === null || at > now) continue;
    const node = byId.get(event.ref);
    out.push({ key: event.id, at, verb, ...describe(node), text: event.text || node?.label || "", cell: node && familyOf(node) ? node.id : null });
  }
  for (const node of nodes) {
    const at = timeOf(node.recalledAt);
    if (at === null || at > now || !familyOf(node)) continue;
    out.push({ key: `recall:${node.id}`, at, verb: "想起", ...describe(node), text: node.label, cell: node.id });
  }
  return out.sort((left, right) => right.at - left.at || left.key.localeCompare(right.key)).slice(0, limit);
}

export interface RingHeatRow { word: string; tone: string; hours: number[] }

/** The last 24 hours by the hour, a row for each kind that has anything in them: what was written, changed or recalled. Oldest hour first. */
export function ringHeat(log: readonly RingLogEntry[], now: number): RingHeatRow[] {
  const rows = new Map<string, RingHeatRow>();
  for (const entry of log) {
    const age = now - entry.at;
    if (age < 0 || age >= 24 * 3_600_000) continue;
    const row = rows.get(entry.word) ?? { word: entry.word, tone: entry.tone, hours: Array.from({ length: 24 }, () => 0) };
    row.hours[23 - Math.floor(age / 3_600_000)] += 1;
    rows.set(entry.word, row);
  }
  // The kinds in the legend's order; a memory the picture no longer holds (forgotten since) last.
  const order = STAR_FAMILY_ORDER.map((family) => STAR_FAMILIES[family].word);
  const rank = (word: string) => { const index = order.indexOf(word); return index < 0 ? order.length : index; };
  return [...rows.values()].sort((left, right) => rank(left.word) - rank(right.word));
}

export interface RingFigure { label: string; value: number | null; unit: string; note: string }

/** The map's sources each figure is counted from (`MemoryMap.missing` names a source that did not answer). */
const MEMORY_SOURCES = ["records", "native-memory", "capsule-notes"];

/**
 * The figures under the ring, each counted from the picture's own marks and events, and null — drawn “—”, never 0 — when a source it is
 * counted from did not answer. A folded group counts what it folds. The documents are the knowledge base's own count where the document
 * carries it, because the map folds document marks first. The learned methods are no figure here: they are their own read (the 做法 tile).
 */
export function ringFigures(
  { nodes, edges, events, missing = [], documentTypes }: {
    nodes: readonly MapNode[]; edges: readonly MapEdge[]; events: readonly MapEvent[];
    missing?: readonly string[]; documentTypes?: ReadonlyArray<{ count: number }>;
  },
  now: number,
): RingFigure[] {
  const memoriesRead = !MEMORY_SOURCES.some((source) => missing.includes(source));
  const documentsRead = !missing.includes("documents");
  const count = (list: readonly MapNode[]) => list.reduce((sum, node) => sum + (node.type === "cluster" ? node.count ?? 1 : 1), 0);
  const within = (at: number | null, days: number) => at !== null && at <= now && now - at < days * 86_400_000;
  const memories = nodes.filter((node) => (node.type === "memory" || (node.type === "cluster" && node.memberType === "memory")) && node.state !== "replaced");
  const held = new Set(ringMarks(nodes).map((node) => node.id));
  const documents = documentTypes ? documentTypes.reduce((sum, item) => sum + item.count, 0) : count(nodes.filter((node) => familyOf(node) === "document" && node.type !== "memory"));
  return [
    { label: "现行的记忆", value: memoriesRead ? count(memories) : null, unit: "条", note: "图里正在生效的" },
    { label: "近 7 天被想起", value: memoriesRead ? nodes.filter((node) => familyOf(node) && within(timeOf(node.recalledAt), 7)).length : null, unit: "条", note: "对话里用到过" },
    { label: "近 30 天记下", value: memoriesRead ? events.filter((event) => event.change === "created" && within(timeOf(event.at), 30)).length : null, unit: "条", note: "都来自你说过的话" },
    // A relation may come from any source (a memory's, a document's, the knowledge graph's): with any of them unread, the count is unknown.
    { label: "关联", value: missing.length === 0 ? edges.filter((edge) => edge.type !== "belongs-to" && held.has(edge.from) && held.has(edge.to)).length : null, unit: "条", note: "记忆之间的连线" },
    { label: "已被替代", value: memoriesRead ? nodes.filter((node) => node.state === "replaced").length : null, unit: "条", note: "留着来龙去脉" },
    { label: "资料", value: documentsRead ? documents : null, unit: "份", note: "记忆依据的文件" },
  ];
}

/**
 * What happened between two readings of the document: the cells written or recalled since the last one, each to get a spark. Nothing on
 * the first reading, which is the page opening and not something happening.
 */
export function freshSignals(previous: { nodes: readonly MapNode[]; events: readonly MapEvent[] } | null, next: { nodes: readonly MapNode[]; events: readonly MapEvent[] }): string[] {
  if (!previous) return [];
  const seen = new Set(previous.events.map((event) => event.id));
  const recalled = new Map(previous.nodes.map((node) => [node.id, node.recalledAt ?? null]));
  const cells = new Set(ringMarks(next.nodes).map((node) => node.id));
  const out = new Set<string>();
  for (const event of next.events) if (!seen.has(event.id) && cells.has(event.ref)) out.add(event.ref);
  for (const node of next.nodes) {
    if (!cells.has(node.id) || !node.recalledAt) continue;
    const before = recalled.get(node.id);
    if (before !== undefined && before !== node.recalledAt) out.add(node.id);
  }
  return [...out];
}
