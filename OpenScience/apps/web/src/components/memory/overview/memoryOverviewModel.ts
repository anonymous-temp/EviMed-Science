import { changeKindOf, weekStart } from "@/components/charts/map/changeWeeks";
import { dayIn } from "@/components/charts/map/zone";
import { glyphOf } from "@/components/memory/map/MarkGlyph";
import { isAboutYou, REASON_TEXT, STRUCTURE } from "@/components/memory/map/mapModel";
import { OTHER_PROJECT_LABEL } from "@/components/memory/memoryItems";
import type { ReceivedCapsule } from "@/lib/memoryClient";
import type { MapEdge, MapNode, MapOpen, MapReason, MemoryMap } from "@/lib/memoryMapClient";
import { methodTitle, type WebMethod } from "@/lib/methodsClient";
import type { NotePart } from "@/components/ui/Note";

/**
 * What the dashboard of 记忆胶囊 draws, decided before any component is asked (the way `mapModel.ts` does for the relation graph).
 *
 * The page is one picture of one capsule: four numbers (关于你, 做法, 收到的, 知识), what the capsule gained and lost over time, the
 * relations and topics when there is enough to see, and the table of changes behind the chart. Every function here is a plain function
 * of what a read returned, so every number on the page can be tested, and nothing here invents one: a part whose read failed is not
 * readable (`readable`) and has no number at all, and the headline names only the parts that were read.
 */

/** The document the overview reads: the map's, without its lineages. */
export type OverviewDoc = Pick<MemoryMap, "summary" | "facets" | "nodes" | "edges" | "buckets" | "events" | "missing" | "scope">;

/**
 * The parts of the capsule the one read of the map answers for. 做法 is not one of them: the map folds its marks to a hundred and fifty, and
 * a learned method is among the first to be folded into a group, so a number made of the map's method marks would say 0 of an account that has
 * them. The methods are their own read (the list the 做法 tab reads), the packs received another.
 */
export type ReadPart = "memories" | "knowledge" | "growth";

/**
 * The map's sources each part is made of. A source that failed is named in `missing`, and a part that needs it was not read: it says so,
 * and is never drawn as zero — the owner's ruling that a partial read error is not a count of nothing.
 */
const READ_FROM: Readonly<Record<ReadPart, readonly string[]>> = {
  memories: ["records", "native-memory", "capsule-notes"],
  knowledge: ["documents"],
  growth: ["records", "native-memory", "capsule-notes", "documents"],
};

/** Whether every source a part is made of answered. */
export function readable(doc: Pick<OverviewDoc, "missing">, part: ReadPart): boolean {
  return !READ_FROM[part].some((name) => doc.missing.includes(name));
}

const DAY_MS = 86_400_000;
const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

// ------------------------------------------------------------------------------------------------ the selection

/** The ranges the toolbar offers, and what each is called in the chart's heading. */
export type RangeKey = "30d" | "90d" | "all";
export const RANGE_OPTIONS: ReadonlyArray<{ value: RangeKey; label: string; words: string }> = [
  { value: "30d", label: "近 30 天", words: "近 30 天" },
  { value: "90d", label: "近 90 天", words: "近 90 天" },
  { value: "all", label: "全部", words: "全部时间" },
];

/** The first day a range includes, counted back from today, today included; null for all of it. */
export function rangeFrom(range: RangeKey, today: string): string | null {
  return range === "30d" ? addDays(today, -29) : range === "90d" ? addDays(today, -89) : null;
}

// ------------------------------------------------------------------------------------------------ the numbers

/** 关于你: the memories about the person, counted by the server before any is folded into a group (`facets.aboutYou`). */
export function aboutYouCount(doc: Pick<OverviewDoc, "nodes" | "facets">): number {
  if (doc.facets.aboutYou) return doc.facets.aboutYou.reduce((sum, kind) => sum + kind.count, 0);
  return doc.nodes.filter((node) => node.type === "memory" && node.state !== "replaced" && isAboutYou(node)).length;
}

/**
 * 关于你 as the list of that name draws it: the memories about the person and, after them, the ones that carry a project (its own group,
 * 「项目记忆」). A person has one capsule and a project is a label on a memory, so the tile, the sentence and the list count the same
 * memories. A memory of a project is any memory that is not about the person (`isAboutYou`): the ones that name a project, and the ones that
 * name none the account still has.
 */
export function rememberedCount(doc: Pick<OverviewDoc, "nodes" | "facets" | "summary">): number {
  const named = doc.facets.projects.reduce((sum, project) => sum + project.memories, 0);
  return Math.max(doc.summary.memories, aboutYouCount(doc) + named);
}

/** 知识: the documents, counted by the knowledge base (`facets.documentTypes`: whole, compiled pages left out, not the page of marks). */
export function knowledgeCount(doc: Pick<OverviewDoc, "nodes" | "facets" | "summary">): number {
  return doc.facets.documentTypes ? doc.facets.documentTypes.reduce((sum, type) => sum + type.count, 0) : doc.summary.documents;
}

/** 收到的: the packs in force, and all of them. */
export function receivedCounts(packs: readonly Pick<ReceivedCapsule, "enabled" | "takenDown">[]): { enabled: number; all: number } {
  return { enabled: packs.filter((pack) => pack.enabled && !pack.takenDown).length, all: packs.length };
}

// ------------------------------------------------------------------------------------------------ 需要看一眼

/** A memory that needs a second look, as a row of the table: the reason is what it says under its title. */
export interface LookRow {
  id: string;
  title: string;
  reason: string;
  at: string | null;
  open: MapOpen | null;
  node: Pick<MapNode, "type" | "subtype" | "state">;
}

const REASON_ORDER: readonly MapReason[] = ["source-retracted", "conflict", "source-changed", "source-expired", "expired"];

const memoriesOf = (doc: Pick<OverviewDoc, "nodes">) => doc.nodes.filter((node) => node.type === "memory" && node.state !== "replaced");

/** What needs a second look — a source a memory rests on changed, two statements disagree — the most worth knowing first. */
export function needsLook(doc: Pick<OverviewDoc, "nodes" | "summary">): { count: number; rows: LookRow[] } {
  const rank = (node: MapNode) => { const at = REASON_ORDER.indexOf(node.reason as MapReason); return at < 0 ? REASON_ORDER.length : at; };
  const marked = memoriesOf(doc).filter((node) => node.state === "check").sort((left, right) => rank(left) - rank(right)
    || String(right.at ?? "").localeCompare(String(left.at ?? "")) || left.id.localeCompare(right.id));
  const rows = marked.map((node): LookRow => ({
    id: node.id, title: node.label, reason: REASON_TEXT[node.reason as MapReason] ?? "需要看一眼", at: node.at ?? null, open: node.open ?? null,
    node: { type: node.type, subtype: node.subtype, state: node.state },
  }));
  return { count: Math.max(doc.summary.needsLook, rows.length), rows };
}

// ------------------------------------------------------------------------------------------------ 变化

export type Lane = "noted" | "learned" | "documents" | "received" | "forgotten";
/** The lanes of the chart, top to bottom, with the word and the shape of each: what the capsule gained and what it lost. */
export const LANES: readonly Lane[] = ["noted", "learned", "documents", "received", "forgotten"];
export const LANE_WORDS: Readonly<Record<Lane, string>> = { noted: "记下", learned: "学会", documents: "资料", received: "收下", forgotten: "忘记" };
export const LANE_GLYPHS: Readonly<Record<Lane, string>> = { noted: "●", learned: "▲", documents: "■", received: "◆", forgotten: "✕" };

/** One change: a memory noted or forgotten, a method learned, a document added, a pack taken in — on the day it happened in the researcher's zone. */
export interface ChangeEvent {
  lane: Lane;
  /** YYYY-MM-DD in the researcher's zone. */
  day: string;
  title: string | null;
  /** A drawer of the memory page's own (a memory, a note, a method), or null where a press goes elsewhere (`target`). */
  open: MapOpen | null;
  /** The pack a 收下 opens, the mark's id for the others: what a row and a dot of one change share. */
  id: string;
  /** Where the change sits: the project a memory belongs to, null for what is about the person or is not a memory. */
  projectId: string | null;
  /** The memory is about the person (关于你), not a project's. */
  about: boolean;
  /** The memory's state, for the table's glyph. */
  state: MapNode["state"];
}

/**
 * The changes of the capsule, one event each: the memories noted and forgotten (a memory replaced since is not counted twice — what replaced it
 * carries on), the methods learned (the 做法 tab's own list), the documents added (the knowledge base's own days) and the packs received.
 * A lane is drawn only when it has events; a statement replaced, an update and a confirmation are real events too, and none of them makes the
 * capsule hold more or less, so none is a mark here.
 */
export function changeEvents(
  doc: Pick<OverviewDoc, "nodes" | "events" | "buckets" | "scope">,
  received: ReadonlyArray<Pick<ReceivedCapsule, "id" | "title" | "importedAt">>,
  methods: ReadonlyArray<Pick<WebMethod, "id" | "title" | "name" | "createdAt" | "statusChangedAt" | "updatedAt" | "status">> = [],
): ChangeEvent[] {
  const zone = doc.scope.timeZone;
  const byId = new Map(doc.nodes.map((node) => [node.id, node]));
  const dayOf = (at: string) => { const ms = Date.parse(at); return Number.isFinite(ms) ? dayIn(ms, zone) : null; };
  const out: ChangeEvent[] = [];
  for (const event of doc.events) {
    const kind = changeKindOf(event);
    if (kind !== "noted" && kind !== "forgotten") continue;
    if (kind === "noted" && event.type !== "memory") continue;
    const node = byId.get(event.ref);
    if (kind === "noted" && node?.state === "replaced") continue;
    const day = dayOf(event.at);
    if (!day) continue;
    out.push({
      lane: kind === "noted" ? "noted" : "forgotten", day, title: event.text || node?.label || null, open: kind === "noted" ? node?.open ?? null : null,
      id: event.ref, projectId: node?.projectId ?? null, about: node ? isAboutYou(node) : false, state: node?.state ?? "current",
    });
  }
  for (const method of methods) {
    if (method.status !== "approved") continue;
    const at = learnedAt(method);
    const day = at ? dayOf(at) : null;
    if (day) out.push({ lane: "learned", day, title: methodTitle(method), open: { kind: "method", id: method.id }, id: `method:${method.id}`, projectId: null, about: false, state: "current" });
  }
  for (const bucket of doc.buckets.series) {
    for (let index = 0; index < (Number(bucket.document) || 0); index += 1) {
      out.push({ lane: "documents", day: bucket.t, title: null, open: null, id: `documents:${bucket.t}`, projectId: null, about: false, state: "current" });
    }
  }
  for (const pack of received) {
    const day = pack.importedAt ? dayOf(pack.importedAt) : null;
    if (day) out.push({ lane: "received", day, title: pack.title, open: null, id: `pack:${pack.id}`, projectId: null, about: false, state: "current" });
  }
  return out.sort((left, right) => left.day.localeCompare(right.day) || LANES.indexOf(left.lane) - LANES.indexOf(right.lane));
}

/** The day a method was learned, as its row says it: when it was first written. */
const learnedAt = (method: Pick<WebMethod, "createdAt" | "statusChangedAt" | "updatedAt">): string | null => method.createdAt || method.statusChangedAt || method.updatedAt || null;

/** What narrows the changes: the range, one week the chart selected, and the search; and, while only what needs a look is shown, the memories that do. */
export interface ChangeNarrowing {
  from: string | null;
  today: string;
  /** The Monday of the selected week. */
  week: string | null;
  query: string;
  /** Only the memories with these marks' ids (`memory:…`): the memories that need a look. */
  only: ReadonlySet<string> | null;
}

/** The changes inside the narrowing, in the order they were given. A search matches a title; a week is the seven days from its Monday. */
export function narrowChanges(events: readonly ChangeEvent[], narrowing: ChangeNarrowing): ChangeEvent[] {
  const text = narrowing.query.trim().toLowerCase();
  const weekEnd = narrowing.week ? addDays(narrowing.week, 6) : null;
  return events.filter((event) => (
    (!narrowing.from || event.day >= narrowing.from) && event.day <= narrowing.today
    && (!narrowing.week || (event.day >= narrowing.week && event.day <= (weekEnd as string)))
    && (!text || (event.title ?? "").toLowerCase().includes(text))
    && (!narrowing.only || (event.lane === "noted" && narrowing.only.has(event.id)))
  ));
}

export interface Growth {
  total: number;
  /** The lanes that have events, in the chart's order. */
  lanes: Lane[];
  counts: Record<Lane, number>;
  /** The first day anything changed, and today. */
  first: string | null;
  today: string;
  /** A dot for each event up to thirty in all; weekly counts for each lane after that. */
  shape: "none" | "dots" | "weeks";
  /** The axis counts days under 14 days of history and weeks after. */
  axis: "days" | "weeks";
  weeks: Array<{ start: string; end: string; counts: Record<Lane, number> }>;
}

/** How many events the chart draws a dot for each of; one more and it counts the weeks. */
export const DOT_LIMIT = 30;

const emptyCounts = (): Record<Lane, number> => ({ noted: 0, learned: 0, documents: 0, received: 0, forgotten: 0 });

/** The chart: its lanes, its counts and the form it is drawn in. @param today YYYY-MM-DD in the researcher's zone */
export function growthOf(events: readonly ChangeEvent[], today: string): Growth {
  const counts = emptyCounts();
  for (const event of events) counts[event.lane] += 1;
  const lanes = LANES.filter((lane) => counts[lane] > 0);
  const total = events.length;
  const first = events.map((event) => event.day).sort()[0] ?? null;
  const last = first && today < first ? first : today;
  const span = first ? Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / DAY_MS) : 0;
  const weeks: Growth["weeks"] = [];
  if (first) {
    for (let start = weekStart(first); start <= last; start = addDays(start, 7)) weeks.push({ start, end: addDays(start, 6), counts: emptyCounts() });
    for (const event of events) {
      const held = weeks.find((week) => event.day >= week.start && event.day <= week.end);
      if (held) held.counts[event.lane] += 1;
    }
  }
  return { total, lanes, counts, first, today: last, shape: total === 0 ? "none" : total <= DOT_LIMIT ? "dots" : "weeks", axis: span < 14 ? "days" : "weeks", weeks };
}

/** How many events fell in the last thirty days, today included, and met a test. */
export function recentCount(events: readonly ChangeEvent[], today: string, test: (event: ChangeEvent) => boolean = () => true): number {
  const from = addDays(today, -29);
  return events.filter((event) => event.day >= from && event.day <= today && test(event)).length;
}

/**
 * The latest day something was remembered or learned, in the researcher's zone, or null. A pack taken in, a document added and a memory forgotten are
 * changes of the chart and are not what 「最近一次」 says after 「记住了」 and 「学会了」.
 */
export function lastChangeDay(events: readonly ChangeEvent[]): string | null {
  return events.reduce<string | null>((latest, event) => (
    (event.lane === "noted" || event.lane === "learned") && (latest === null || event.day > latest) ? event.day : latest
  ), null);
}

// ------------------------------------------------------------------------------------------------ the table

/** One row of 「最近变化」. */
export interface ChangeRow {
  key: string;
  lane: Lane;
  title: string;
  /** 「记下 · 10月24日 · 关于你」: the word of the change, its day, where it sits. */
  meta: string;
  /** The mark in front of the row: the lane's own shape (or the memory's, for a memory that needs a look), and the state that tints it. */
  glyph: string;
  state: MapNode["state"];
  /** What a press does: a drawer, the received pack's drawer, the forgotten list, or a page of the knowledge base (↗, it leaves the section). */
  target: { kind: "drawer"; open: MapOpen } | { kind: "pack"; id: string } | { kind: "forgotten" } | { kind: "files" };
}

/** Where a change sits, in a word: the project a memory belongs to, 关于你, or what the other lanes are. */
function whereOf(event: ChangeEvent, projectName: (id: string | null) => string | null): string {
  if (event.lane === "documents") return "知识";
  if (event.lane === "received") return "收到的";
  if (event.lane === "learned") return "做法";
  if (event.about) return "关于你";
  if (event.projectId) return projectName(event.projectId) ?? OTHER_PROJECT_LABEL;
  return event.lane === "forgotten" ? "" : OTHER_PROJECT_LABEL;
}

/**
 * The changes as the rows of the table behind the chart, newest first. Documents added on one day are one row (the knowledge base has days, not
 * titles, to give); a change whose press has nowhere to go (a memory forgotten opens the forgotten list, a memory with no drawer) is still a row.
 */
export function changeRows(events: readonly ChangeEvent[], { projectName, formatDay: sayDay }: { projectName: (id: string | null) => string | null; formatDay: (day: string) => string }): ChangeRow[] {
  const rows: ChangeRow[] = [];
  const documents = new Map<string, number>();
  for (const event of events) if (event.lane === "documents") documents.set(event.day, (documents.get(event.day) ?? 0) + 1);
  const seen = new Set<string>();
  [...events].reverse().forEach((event, index) => {
    const word = LANE_WORDS[event.lane];
    const place = whereOf(event, projectName);
    if (event.lane === "documents") {
      if (seen.has(event.day)) return;
      seen.add(event.day);
      rows.push({
        key: `documents:${event.day}`, lane: "documents", title: `放进 ${documents.get(event.day)} 份资料`, meta: [word, sayDay(event.day), place].filter(Boolean).join(" · "),
        glyph: LANE_GLYPHS.documents, state: "current", target: { kind: "files" },
      });
      return;
    }
    const target: ChangeRow["target"] | null = event.lane === "received" ? { kind: "pack", id: event.id.slice("pack:".length) }
      : event.lane === "forgotten" ? { kind: "forgotten" }
        : event.open ? { kind: "drawer", open: event.open } : null;
    if (!target) return;
    rows.push({
      key: `${event.lane}:${event.id}:${index}`, lane: event.lane, title: event.title ?? `${word}了一件事`, meta: [word, sayDay(event.day), place].filter(Boolean).join(" · "),
      glyph: LANE_GLYPHS[event.lane], state: event.lane === "forgotten" ? "replaced" : event.state ?? "current", target,
    });
  });
  return rows;
}

/** A memory that needs a look, as a row of the table: the reason is its meta. */
export function lookTableRows(rows: readonly LookRow[], query: string): ChangeRow[] {
  const text = query.trim().toLowerCase();
  return rows.filter((row) => !text || row.title.toLowerCase().includes(text)).flatMap((row): ChangeRow[] => (row.open
    ? [{ key: row.id, lane: "noted", title: row.title, meta: row.reason, glyph: glyphOf(row.node), state: row.node.state, target: { kind: "drawer", open: row.open } }]
    : []));
}

// ------------------------------------------------------------------------------------------------ the sentence

/** What the headline says, each number only when its part was read. `null`: that read failed or the part is empty, and the sentence leaves it out. */
export interface HeadlineFacts {
  /** 关于你, a project's memories included (`rememberedCount`). */
  about: number | null;
  methods: number | null;
  /** The latest day anything changed, said as a list says it (「10月24日」); null when unknown. */
  last: string | null;
}

/** Where each number of the headline leads: the list it counts. */
export interface HeadlineLinks { about: string; methods: string }

/**
 * The one sentence over the page: what the capsule holds, each number a link to the list it counts, and when it last changed. 「记住了 23 条关于你的事，
 * 学会了 8 种做法；最近一次在10月24日。」 A clause whose part could not be read or holds nothing is left out — never a 「0」 — and received packs
 * are never counted as memories. `null` when nothing is left to say: an account with nothing has a recipe, not a sentence of zeros.
 */
export function overviewHeadline(facts: HeadlineFacts, links: HeadlineLinks): NotePart[] | null {
  const clauses: NotePart[][] = [];
  if (facts.about) clauses.push(["记住了 ", { n: facts.about, to: links.about, label: `${facts.about} 条关于你的事，看全部` }, " 条关于你的事"]);
  if (facts.methods) clauses.push(["学会了 ", { n: facts.methods, to: links.methods, label: `${facts.methods} 种做法，看全部` }, " 种做法"]);
  if (clauses.length === 0) return null;
  const parts: NotePart[] = [];
  clauses.forEach((clause, index) => { if (index > 0) parts.push("，"); parts.push(...clause); });
  if (facts.last) parts.push(`；最近一次在${facts.last}`);
  parts.push("。");
  return parts;
}

/** The chart's heading words and the day a range begins, for the meta line of its card. */
export function rangeWords(range: RangeKey): string {
  return RANGE_OPTIONS.find((option) => option.value === range)?.words ?? "全部时间";
}

/** Said by the chart's label: 「近 30 天：记下 12，学会 3」. */
export function growthLabel(growth: Growth, words: string): string {
  return `变化，${words}：${growth.lanes.map((lane) => `${LANE_WORDS[lane]} ${growth.counts[lane]}`).join("，")}，明细在下面的表里。`;
}

// ------------------------------------------------------------------------------------------------ 关系与主题

/** How many memories the relation and topic panel waits for, and how many relations (or any topic grouping) it needs beside them. */
export const EXPLORE_MEMORIES = 12;
export const EXPLORE_RELATIONS = 3;

/** The lines that tie one thing to another; a memory's belonging to its project is the picture's layout, not a relation. */
export function relationCount(doc: Pick<OverviewDoc, "edges">): number {
  return doc.edges.filter((edge) => edge.type !== "belongs-to").length;
}

/**
 * Whether 「关系与主题」 is drawn: at least twelve memories, and at least three relations or a grouping of them into topics. Below that a graph is
 * a scatter of dots and a topic cloud one word, and the panel is not drawn at all — no empty frame.
 */
export function exploreOffered(doc: Pick<OverviewDoc, "summary" | "edges" | "facets">): boolean {
  return doc.summary.memories >= EXPLORE_MEMORIES && (relationCount(doc) >= EXPLORE_RELATIONS || doc.facets.topics.length > 0);
}

/** The panel the page opens on when the address names none: the relations when there are enough of them, else the topics. */
export function defaultExplore(doc: Pick<OverviewDoc, "edges">): "graph" | "topics" {
  return relationCount(doc) >= EXPLORE_RELATIONS ? "graph" : "topics";
}

/**
 * The marks and lines inside a range: the account and its projects are always there, a mark with no time (an entity from a compile) is there from
 * the start, anything else is there when it began inside the range.
 */
export function withinRange<T extends Pick<OverviewDoc, "nodes" | "edges">>(doc: T, from: string | null, today: string, timeZone: string): T {
  if (!from) return doc;
  const nodes = doc.nodes.filter((node) => {
    if (STRUCTURE.has(node.type) || !node.at) return true;
    const ms = Date.parse(node.at);
    if (!Number.isFinite(ms)) return true;
    const day = dayIn(ms, timeZone);
    return day >= from && day <= today;
  });
  const kept = new Set(nodes.map((node) => node.id));
  return { ...doc, nodes, edges: (doc.edges as MapEdge[]).filter((edge) => kept.has(edge.from) && kept.has(edge.to)) };
}
