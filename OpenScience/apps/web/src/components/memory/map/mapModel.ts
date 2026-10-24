import type { NotePart } from "@/components/ui/Note";
import { kindTitle } from "@/lib/memoryGroups";
import type { MapEdge, MapNode, MapPart, MapReason, MapTopic, MemoryMap } from "@/lib/memoryMapClient";
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

/** The kinds of memory the memory page files under a project (`recordGroup`); every other kind is about the person. */
const PROJECT_KINDS: ReadonlySet<string> = new Set(["project_fact", "analysis", "decision", "follow_up", "run_summary"]);

/** A mark of a memory — or a cluster that folds some — whichever store it came from. */
function isMemoryMark(node: Pick<MapNode, "type" | "memberType">): boolean {
  return node.type === "memory" || (node.type === "cluster" && node.memberType === "memory");
}

/**
 * Whether a memory is about the person (the memory page's 关于你) and not a project's: it sits in no project and is not of a project's
 * kind. A cluster that folds memories answers for the memories it folds, which are all of one kind and one project.
 */
export function isAboutYou(node: Pick<MapNode, "type" | "memberType" | "subtype" | "projectId">): boolean {
  return isMemoryMark(node) && !node.projectId && !PROJECT_KINDS.has(String(node.subtype));
}

/** What a mark that needs a second look says, in the reader's words. */
export const REASON_TEXT: Readonly<Record<MapReason, string>> = {
  "source-retracted": "依据的资料已撤回",
  "source-changed": "依据的资料有更新",
  "source-expired": "依据的资料已过期",
  conflict: "和另一条说法不一致",
  expired: "已过了有效期",
};

/** Fewer marks or lines than this and a picture says less than the list under it. */

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
 *
 * A `part` is the one narrowing that is not only about memories: it is how a card of the overview opens the map on what it counted —
 * `you` and `project` the memories about the person and a project's (with the projects and the documents they sit in), `method` the learned
 * methods, `knowledge` the documents, pages, entities and works. What a part holds is chosen here, from the marks in hand, so the map
 * reads no more than the overview did.
 */
export function narrowMap(doc: Pick<MemoryMap, "nodes" | "edges" | "facets">, selection: Pick<MapSelection, "topic" | "kind" | "dimension" | "look" | "q"> & { part?: MapPart | null }): NarrowedMap {
  const axis = selection.dimension ? doc.facets.dimensions.flatMap((dimension) => dimension.axes).find((entry) => entry.id === selection.dimension) : undefined;
  const kinds = axis?.kinds ? new Set(axis.kinds) : null;
  const part = selection.part ?? null;
  const derived = selection.topic ? derivedMembers(doc.nodes, selection.topic) : null;
  const narrowed = Boolean(selection.topic || selection.kind || kinds || selection.look || part);
  let nodes = doc.nodes;
  let edges = doc.edges;
  if (narrowed) {
    // A part of the capsule is what a card of the overview opens: the memories about the person, a project's memories and documents, the
    // learned methods, or what is known. Only the first two are memories; the others are chosen below and keep no memory.
    const keepsMemory = part === null || part === "you" || part === "project";
    const keep = (node: MapNode) => (
      (!selection.topic || (derived ? derived.has(node.id) : (node.topics ?? []).includes(selection.topic)))
      && (!selection.kind || node.subtype === selection.kind)
      && (!kinds || kinds.has(String(node.subtype)))
      && (!selection.look || node.state === "check")
      && (part !== "you" || isAboutYou(node))
      && (part !== "project" || !isAboutYou(node))
    );
    const memories = keepsMemory ? new Set(doc.nodes.filter((node) => node.type === "memory" && keep(node)).map((node) => node.id)) : new Set<string>();
    const chosen = new Set<string>(memories);
    // What else the part holds, whatever memory there is: the methods, what is known, and a project's documents.
    if (part === "method") for (const node of doc.nodes) if (node.type === "method") chosen.add(node.id);
    if (part === "knowledge") for (const node of doc.nodes) if (["document", "page", "entity", "reference"].includes(node.type)) chosen.add(node.id);
    if (part === "project") for (const node of doc.nodes) if (node.type === "document" && node.projectId) chosen.add(node.id);
    const tied = new Set<string>(chosen);
    for (const edge of doc.edges) {
      if (edge.type === "belongs-to") continue;
      if (memories.has(edge.from)) tied.add(edge.to);
      if (memories.has(edge.to)) tied.add(edge.from);
    }
    for (const edge of doc.edges) {
      if (edge.type === "belongs-to" && chosen.has(edge.from)) tied.add(edge.to);
    }
    nodes = doc.nodes.filter((node) => tied.has(node.id));
    const kept = new Set(nodes.map((node) => node.id));
    edges = doc.edges.filter((edge) => kept.has(edge.from) && kept.has(edge.to));
  }
  const query = selection.q.trim();
  const hits = query ? new Set(nodes.filter((node) => !STRUCTURE.has(node.type) && matches(`${node.label} ${node.description ?? ""}`, query)).map((node) => node.id)) : new Set<string>();
  return { nodes, edges, hits, narrowed };
}

/** The id of a topic the page made itself (`derivedTopics`), which names its kind (`derived:kind:偏好`) or its project (`derived:project:<id>`). */
export const DERIVED_TOPIC = "derived:";

/**
 * The topics of an account the model has not grouped — fewer memories than it takes (`OPEN_SCIENCE_MEMORY_TOPICS_MIN_MEMORIES`) — made from
 * what the memories already say: a topic for each kind of memory, in the memory page's own word for it, and one for each project that has
 * some. A memory is in its kind and in its project, as the model's topics let it be in up to three. No model is asked and nothing is stored:
 * the researcher's sparse real records stay visible (owner ruling of 2026-10-19) instead of an empty card, and the topics are gone as
 * soon as the model's grouping exists (the page prefers it). `derived` is what tells the view that these are not editable.
 *
 * @param projectName the name of a project, or null when the account no longer has it
 */
export function derivedTopics(doc: Pick<MemoryMap, "nodes">, projectName: (id: string) => string | null, now: Date = new Date()): MapTopic[] {
  const groups = new Map<string, { label: string; members: MapNode[] }>();
  const add = (id: string, label: string, node: MapNode) => {
    const held = groups.get(id) ?? { label, members: [] };
    held.members.push(node);
    groups.set(id, held);
  };
  for (const node of doc.nodes) {
    if (node.type !== "memory" || node.state === "replaced") continue;
    add(`${DERIVED_TOPIC}kind:${kindTitle(String(node.subtype ?? ""))}`, kindTitle(String(node.subtype ?? "")), node);
    if (node.projectId) add(`${DERIVED_TOPIC}project:${node.projectId}`, projectName(node.projectId) ?? "其他项目", node);
  }
  const day = 86_400_000;
  const recent = (node: MapNode, from: number, to: number) => {
    const age = now.getTime() - Date.parse(node.at ?? "");
    return Number.isFinite(age) && age >= from * day && age < to * day;
  };
  return [...groups.entries()].map(([id, group]): MapTopic => ({
    id, label: group.label, weight: group.members.length,
    // The memories begun in the last 30 days less those of the 30 before, as the model's topics count it.
    trend: group.members.filter((node) => recent(node, 0, 30)).length - group.members.filter((node) => recent(node, 30, 60)).length,
    members: group.members.map((node) => node.id), derived: true,
  })).sort((left, right) => right.weight - left.weight || left.id.localeCompare(right.id));
}

/** The memories of a topic the page made, or null for a topic the model made (its members are marked on the nodes). */
function derivedMembers(nodes: readonly MapNode[], topic: string): Set<string> | null {
  if (!topic.startsWith(DERIVED_TOPIC)) return null;
  const [, kind, ...rest] = topic.split(":");
  const value = rest.join(":");
  return new Set(nodes.filter((node) => node.type === "memory" && node.state !== "replaced"
    && (kind === "project" ? node.projectId === value : kindTitle(String(node.subtype ?? "")) === value)).map((node) => node.id));
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
  const { memories, needsLook, documents, methods } = doc.summary;
  if (memories === 0) {
    // What the page draws is not nothing because no memory was written: a graph of documents under 「还没有记住什么」 was the one sentence
    // of the landing, and it said the opposite of the picture. The sentence says what is there, and that no memory is yet.
    const holds = [documents > 0 ? `${documents} 份资料` : "", methods > 0 ? `${methods} 种做法` : ""].filter(Boolean);
    return [{ text: holds.length > 0 ? `胶囊里有 ${holds.join("、")}，还没有记下关于你的事。` : "还没有记住什么。" }];
  }
  const sources = doc.nodes.filter((node) => node.type === "memory" && node.state === "check" && String(node.reason ?? "").startsWith("source-")).length;
  const base = `EviMed 记住了你的 ${memories} 件事`;
  if (needsLook === 0) return [{ text: `${base}。` }];
  if (sources > 0 && sources >= needsLook / 2) return [{ text: `${base}，其中 ` }, { text: `${needsLook} 件`, action: "look" }, { text: "依据的资料变了或需要核对。" }];
  return [{ text: `${base}，其中 ` }, { text: `${needsLook} 件`, action: "look" }, { text: "需要看一眼。" }];
}

/**
 * The sentence over the relation picture, in its numbers: how many memories in force, tied to how many documents and projects. It is
 * counted over the marks drawn, so a narrowed or replayed picture says what it holds and not what the account does.
 */
export function relationTitle(nodes: readonly Pick<MapNode, "type" | "state">[]): string {
  const memories = nodes.filter((node) => node.type === "memory" && node.state !== "replaced").length;
  const documents = nodes.filter((node) => node.type === "document" || node.type === "page").length;
  const projects = nodes.filter((node) => node.type === "project").length;
  const tied = [documents > 0 ? `${documents} 份资料` : "", projects > 0 ? `${projects} 个项目` : ""].filter(Boolean).join("和 ");
  if (memories === 0) return "记忆、资料和项目的关系";
  return tied ? `${memories} 件现行的记忆，连着 ${tied}` : `${memories} 件现行的记忆`;
}

/**
 * The sentence as the page's `Headline` slot takes it: the number that needs a look is a link that narrows the map to those marks
 * (`onLook`), and its unit stays outside the link.
 */
export function headlineParts(parts: readonly HeadlinePart[], onLook: () => void): NotePart[] {
  return parts.flatMap((part): NotePart[] => {
    if (part.action !== "look") return [part.text];
    const n = Number.parseInt(part.text, 10);
    return Number.isFinite(n) ? [{ n, onOpen: onLook, label: `${part.text}，只看这些` }, part.text.slice(String(n).length)] : [part.text];
  });
}

export function headlineText(parts: readonly HeadlinePart[]): string {
  return parts.map((part) => part.text).join("");
}

/** A single real mark is drawable; a lack of relationships must not hide memories or documents. */
export function isThin(doc: Pick<MemoryMap, "nodes" | "edges">): boolean {
  return !doc.nodes.some((node) => node.type !== "you");
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
