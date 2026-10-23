/**
 * The memory map's client: the one document every view is drawn from (`GET /api/memory/map`), the topics the researcher edits, and
 * the links the memory drawer shows. Kept apart from `memoryClient.ts` so the map's calls change in one place.
 *
 * The document is derived on the server when read and writes nothing; the only calls here that change anything are the topic edits
 * and the request that asks for a regrouping.
 */
import { productRequest } from "./productClient";

export type MapView = "graph" | "topics" | "dims" | "time" | "activity";
export const MAP_VIEWS: readonly MapView[] = ["graph", "topics", "dims", "time", "activity"];

/**
 * The parts of a capsule the overview's cards drill into the map by: what is about the person, what is in a project, what was learned to do,
 * and what is known. 成长 is the time view and 收到的 is not on the map at all, so neither is a part.
 */
export type MapPart = "you" | "project" | "method" | "knowledge";
export const MAP_PARTS: readonly MapPart[] = ["you", "project", "method", "knowledge"];

export type MapNodeType = "you" | "project" | "memory" | "document" | "reference" | "method" | "entity" | "page" | "cluster";
export type MapState = "current" | "check" | "replaced";
export type MapReason = "source-retracted" | "conflict" | "source-changed" | "source-expired" | "expired";

/**
 * What a click on a mark opens: the memory drawer, the drawer of a note of the researcher's own capsule (`entry`, which the memory page
 * opens the same way), the method drawer, or an address of its own.
 */
export type MapOpen = { kind: "record"; id: string } | { kind: "entry"; id: string } | { kind: "method"; id: string } | { kind: "page"; href: string };

export interface MapNode {
  id: string;
  type: MapNodeType;
  subtype?: string | null;
  group?: string;
  label: string;
  weight?: number;
  at?: string | null;
  state?: MapState;
  reason?: MapReason | null;
  projectId?: string | null;
  topics?: string[];
  open?: MapOpen | null;
  /** A cluster's size, and the kind of mark it stands for. */
  count?: number;
  memberType?: MapNodeType;
  description?: string;
}

export type MapEdgeType = "belongs-to" | "rests-on" | "replaces" | "conflicts" | "links" | "quotes" | "relates";
export interface MapEdge {
  /** The line's stable id, which 「这条关联不对」 names; absent from a control plane older than it. */
  id?: string;
  from: string;
  to: string;
  type: MapEdgeType;
  /** For `rests-on`: what a check found about the source. */
  state?: "current" | "changed" | "retracted" | "expired" | "unknown";
  at?: string | null;
  label?: string;
}

export interface MapAxis {
  id: string;
  label: string;
  value: number;
  previousValue: number;
  count: number;
  /** For the memory aspects: the kinds of memory the axis counts. */
  kinds?: string[];
}
export interface MapDimension {
  id: "work" | "memory";
  title: string;
  previous: string;
  scale: "share" | "count";
  total: number;
  previousTotal: number;
  axes: MapAxis[];
}
export interface MapTopic {
  id: string;
  label: string;
  weight: number;
  trend: number;
  /** Mark ids, `memory:<id>`. */
  members: string[];
  /** Made by the page, not grouped by the model (`derivedTopics`): it cannot be renamed, merged or dismissed, and is gone once the model's grouping exists. */
  derived?: boolean;
}
export interface MapLaneSegment {
  recordId: string;
  text: string;
  from: string | null;
  to: string | null;
  state: "current" | "replaced";
  conflict: boolean;
}
export interface MapLane {
  id: string;
  label: string;
  projectId: string | null;
  segments: MapLaneSegment[];
}
export interface MapEvent {
  id: string;
  at: string;
  type: "memory" | "method" | "feedback" | "run";
  change: string;
  ref: string;
  lane: string;
  kind?: string;
  text?: string;
}
export interface MapDay {
  t: string;
  memory: number;
  run: number;
  method: number;
  feedback: number;
  /** The documents added to the knowledge base that day (the newest the map read of each project); absent from a control plane older than the overview. */
  document?: number;
}

export interface MemoryMap {
  version: 1;
  /** Which store keeps the account's memories; absent from a control plane older than the overview. */
  engine?: "postgres" | "native";
  scope: { projectId: string | null; range: { from: string | null; to: string; unit: "day" | "week" | "month" }; timeZone: string; focus: string | null; depth: number | null };
  status: { topics: "ready" | "stale" | "empty" | "off" };
  summary: { memories: number; documents: number; methods: number; projects: number; needsLook: number; since: string | null };
  facets: {
    projects: Array<{ id: string; name: string; kind: string; memories: number; documents: number }>;
    kinds: Array<{ id: string; label: string; count: number }>;
    /** The memories about the person by kind, counted before any is folded into a cluster; absent from a control plane older than the overview. */
    aboutYou?: Array<{ id: string; label: string; count: number }>;
    /** The knowledge base's own count of its documents by kind, compiled pages left out, whole and not the page of marks. */
    documentTypes?: Array<{ id: string; label: string; count: number }>;
    topics: MapTopic[];
    dimensions: MapDimension[];
  };
  nodes: MapNode[];
  edges: MapEdge[];
  buckets: { unit: "day"; series: MapDay[] };
  lanes: MapLane[];
  events: MapEvent[];
  truncated: { nodes: number; edges: number };
  missing: string[];
}

export interface MapQuery {
  projectId: string | null;
  range: string;
  focus: string | null;
  depth: number;
}

/** Every block of the document: the views switch between them without asking again. */
export const MAP_INCLUDE_ALL = "summary,facets,nodes,edges,buckets,lanes,events";
/** What the overview reads: no lines and no lineages, which only the relation and time views draw. */
export const MAP_INCLUDE_OVERVIEW = "summary,facets,nodes,buckets,events";

/** The whole document, every block: the views switch between them without asking again. The overview asks for the blocks it draws. */
export function fetchMemoryMap(query: MapQuery, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone, include = MAP_INCLUDE_ALL): Promise<MemoryMap> {
  const params = new URLSearchParams({ include, timeZone });
  if (query.projectId) params.set("projectId", query.projectId);
  if (query.range && query.range !== "all") params.set("range", query.range);
  if (query.focus) {
    params.set("focus", query.focus);
    params.set("depth", String(query.depth));
  }
  return productRequest<MemoryMap>(`/memory/map?${params.toString()}`);
}

export interface TopicsState {
  status: "ready" | "stale" | "empty" | "off";
  topics: Array<{ id: string; label: string; weight: number; trend: number; members: string[]; edited: boolean }>;
}

/** Ask for a regrouping of the topics; the server groups only if the memories changed and the day's bound allows. */
export function refreshTopics() {
  return productRequest<{ status: TopicsState["status"]; made: boolean; bounded?: boolean }>("/memory/topics/refresh", "POST");
}

export type TopicEdit = { label: string } | { mergeInto: string } | { dismiss: true } | { removeMember: string };

/** The researcher's word about a topic: a rename, a merge, a topic dismissed, a memory taken out. Costs no model call. */
export function editTopic(id: string, edit: TopicEdit) {
  return productRequest<TopicsState>(`/memory/topics/${encodeURIComponent(id)}`, "PATCH", edit);
}

export interface RecordNeighbour {
  id: string;
  kind: string;
  status: string;
  sensitive: boolean;
  text: string;
  from: string | null;
  to: string | null;
}
export interface RecordLinks {
  rests: Array<{ type: string; id: string; state: string; title: string | null; href: string | null }>;
  replaced: RecordNeighbour[];
  replacedBy: RecordNeighbour | null;
  conflicts: RecordNeighbour[];
  usedIn: Array<{ sessionId: string; projectId: string; title: string; at: string | null }>;
}

/** What one memory is tied to, read when its drawer opens. */
export function fetchRecordLinks(recordId: string) {
  return productRequest<RecordLinks>(`/memory/records/${encodeURIComponent(recordId)}/links`);
}

/**
 * 「这条关联不对」: a line of the relation view the researcher says is wrong stays out of their map (`hidden: true`), or is drawn again
 * (`hidden: false`). The source of the line is untouched; it is a correction about what this person is shown.
 */
export function hideMapEdge(edgeId: string, hidden: boolean) {
  return productRequest<{ hidden: boolean }>(`/memory/map/edges/${encodeURIComponent(edgeId)}`, "PUT", { hidden });
}
