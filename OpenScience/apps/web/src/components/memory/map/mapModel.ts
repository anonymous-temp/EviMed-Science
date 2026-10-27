import { kindTitle } from "@/lib/memoryGroups";
import type { MapEdge, MapNode, MapReason, MapTopic, MemoryMap } from "@/lib/memoryMapClient";

/**
 * What the relation graph and the topics draw, decided before any chart library is asked (the way `trendModel.ts` does for the trend line).
 *
 * Every function here is a plain function of the document and the selection: narrowing it, saying it in a sentence. Nothing touches a
 * canvas, so all of it is tested without a browser.
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

/** What narrows the document: a topic, only what needs a look, and the search. */
export interface MapNarrowing {
  topic: string | null;
  look: boolean;
  q: string;
}

/**
 * The document narrowed by a topic, "needs a look" and the search — all on the document in hand, so the panels switch at once.
 *
 * A narrowing is about memories: the memories that stay are the ones that match, and what is tied to them (their project, the
 * documents they rest on, what they replaced) stays with them. A mark nothing narrowed memory ties to — a method, an entity — is
 * there while nothing narrows and is gone while something does. A search does not remove anything from the picture, it names hits
 * (`hits`) for the picture to light up.
 */
export function narrowMap(doc: Pick<MemoryMap, "nodes" | "edges">, selection: MapNarrowing): NarrowedMap {
  const derived = selection.topic ? derivedMembers(doc.nodes, selection.topic) : null;
  const narrowed = Boolean(selection.topic || selection.look);
  let nodes = doc.nodes;
  let edges = doc.edges;
  if (narrowed) {
    const keep = (node: MapNode) => (
      (!selection.topic || (derived ? derived.has(node.id) : (node.topics ?? []).includes(selection.topic)))
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
    if (node.projectId) add(`${DERIVED_TOPIC}project:${node.projectId}`, projectName(node.projectId) ?? "未归入项目", node);
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
