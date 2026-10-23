import { changeKindOf, weekStart } from "@/components/charts/map/changeWeeks";
import { dayIn } from "@/components/charts/map/zone";
import { isAboutYou, REASON_TEXT } from "@/components/memory/map/mapModel";
import { formatDay } from "@/lib/format";
import { SELF_SECTIONS, selfSection, type SelfSection } from "@/lib/memoryGroups";
import type { ReceivedCapsule } from "@/lib/memoryClient";
import type { MapNode, MapOpen, MapPart, MapReason, MemoryMap } from "@/lib/memoryMapClient";
import { methodTitle, type WebMethod } from "@/lib/methodsClient";
import type { NotePart } from "@/components/ui/Note";

/**
 * What the overview of 记忆胶囊 draws, decided before any component is asked (the way `mapModel.ts` does for the map).
 *
 * The overview is six parts of one capsule — 成长, 关于你, 项目, 我的做法, 知识, 收到的 — each a card with a number, a mark and one action. A card's
 * mark **changes form with the amount it has to show** (H report §4.3; Weissgerber 2015: with few points show the points, not a bar of
 * them), and the amounts are the plain numbers below, in one place, so the page and its tests cannot disagree about where a list becomes bars:
 *
 *   0      a recipe: what the card is made of, what it gives, and one button
 *   1–5    the things themselves, as rows
 *   6–30   ranked bars, or dots on an axis
 *   31+    folded: bars and the newest three, or weekly counts
 *
 * Every function here is a plain function of what a read returned, so every number on the page can be tested, and nothing here
 * invents one: a card whose read failed has no model at all (`readable`), and the headline names only the parts that were read.
 */

/** How many things a card lists as themselves; one more and it is a mark that counts them. */
export const FEW_MAX = 5;
/** How many a card draws one by one — dots, ranked bars — before it folds them. */
export const SOME_MAX = 30;
/** How many events the growth strip draws one dot each for; one more and it counts the weeks. */
export const DOT_LIMIT = 30;
/** The most rows a card of projects, received packs or things to look at lists before 「全部 N 个」. */
export const TOP_ROWS = 8;
/** What to look at, listed: the rest is a count and a link. */
export const LOOK_ROWS = 5;

export type Amount = "none" | "few" | "some" | "many";

/** The amount a count is drawn for: 0, 1–5, 6–30, 31 and more. */
export function amountOf(count: number): Amount {
  if (!Number.isFinite(count) || count <= 0) return "none";
  if (count <= FEW_MAX) return "few";
  return count <= SOME_MAX ? "some" : "many";
}

/** The document the overview reads: the map's, without its lines and lineages. */
export type OverviewDoc = Pick<MemoryMap, "summary" | "facets" | "nodes" | "buckets" | "events" | "missing" | "scope"> & { engine?: MemoryMap["engine"] };

/**
 * The parts of the capsule the one read of the map answers for. 我的做法 is not one of them: the map folds its marks to a hundred and fifty, and
 * a learned method is among the first to be folded into a group (it has no weight and ranks under the documents), so a card made of the map's
 * method marks would say 「还没有做法」 of an account that has them. The methods are their own read (`methodsCard`, the list the 做法 tab reads).
 */
export type ReadPart = "memories" | "projects" | "knowledge" | "growth";

/**
 * The map's sources each part is made of. A source that failed is named in `missing`, and a part that needs it was not read: it says so,
 * and is never drawn as zero — the owner's ruling that a partial read error is not a count of nothing.
 */
const READ_FROM: Readonly<Record<ReadPart, readonly string[]>> = {
  memories: ["records", "native-memory", "capsule-notes"],
  projects: ["records", "native-memory", "capsule-notes", "documents"],
  knowledge: ["documents"],
  growth: ["records", "native-memory", "capsule-notes", "documents"],
};

/** Whether every source a part is made of answered. */
export function readable(doc: Pick<OverviewDoc, "missing">, part: ReadPart): boolean {
  return !READ_FROM[part].some((name) => doc.missing.includes(name));
}

/** A thing a card lists: a mark of the map, as a row of its list. */
export interface MarkRow {
  id: string;
  title: string;
  at: string | null;
  node: Pick<MapNode, "type" | "subtype" | "state">;
  /** What a press opens: the memory's, the note's or the method's drawer, or a page. */
  open: MapOpen | null;
  projectId: string | null;
}

function rowOf(node: MapNode): MarkRow {
  return { id: node.id, title: node.label, at: node.at ?? null, node: { type: node.type, subtype: node.subtype, state: node.state }, open: node.open ?? null, projectId: node.projectId ?? null };
}

/** The newest first; the id breaks a tie so the order never depends on the order the sources answered in. */
function newestFirst(rows: MarkRow[]): MarkRow[] {
  return rows.sort((left, right) => String(right.at ?? "").localeCompare(String(left.at ?? "")) || left.id.localeCompare(right.id));
}

const memoriesOf = (doc: Pick<OverviewDoc, "nodes">) => doc.nodes.filter((node) => node.type === "memory" && node.state !== "replaced");

// ------------------------------------------------------------------------------------------------ 关于你

export interface AboutYouCard {
  count: number;
  /** `recipe` has nothing yet, `rows` lists the statements themselves, `bars` ranks the aspects. */
  shape: "recipe" | "rows" | "bars";
  rows: MarkRow[];
  /** The aspects of the person the memories are filed under, most first; never a radar here. */
  bars: Array<{ key: SelfSection; label: string; count: number }>;
  /** The newest three, drawn under the bars of a capsule that has many. */
  newest: MarkRow[];
}

/**
 * 关于你: what the capsule holds about the person — the memories the memory page files under 关于你, counted by the server before any is folded
 * (`facets.aboutYou`) so the number is the list's. The statements themselves up to five; ranked bars by aspect from six on.
 */
export function aboutYouCard(doc: Pick<OverviewDoc, "nodes" | "facets">): AboutYouCard {
  const mine = memoriesOf(doc).filter(isAboutYou);
  const kinds = doc.facets.aboutYou ?? Object.entries(mine.reduce<Record<string, number>>((tally, node) => ({ ...tally, [String(node.subtype)]: (tally[String(node.subtype)] ?? 0) + 1 }), {})).map(([id, count]) => ({ id, label: id, count }));
  const count = kinds.reduce((sum, kind) => sum + kind.count, 0);
  const rows = newestFirst(mine.map(rowOf));
  const tally = new Map<SelfSection, number>();
  for (const kind of kinds) tally.set(selfSection(kind.id), (tally.get(selfSection(kind.id)) ?? 0) + kind.count);
  const bars = SELF_SECTIONS.filter((section) => (tally.get(section.key) ?? 0) > 0)
    .map((section) => ({ key: section.key, label: section.label, count: tally.get(section.key) ?? 0 }))
    .sort((left, right) => right.count - left.count);
  // The rows are the statements only while the page holds all of them: a capsule folded into groups lists none one by one.
  const shape = count === 0 ? "recipe" : count <= FEW_MAX && rows.length === count ? "rows" : "bars";
  return { count, shape, rows: shape === "rows" ? rows : [], bars, newest: count > SOME_MAX ? rows.slice(0, 3) : [] };
}

// ------------------------------------------------------------------------------------------------ 项目

export interface ProjectRow {
  /** The project's id, or `__other` for the memories that name a project the account no longer has. */
  id: string;
  name: string;
  memories: number;
  documents: number;
  /** Its memories that need a look. */
  needsLook: number;
  /** The newest thing in it. */
  at: string | null;
}

export interface ProjectsCard {
  /** The projects that hold something. */
  count: number;
  /** How many memories sit in projects: the part of the capsule's memories that is not about the person. */
  memories: number;
  /** One project is its card slots as facts; several are a table with a bar in each row. */
  shape: "recipe" | "single" | "table";
  /** The most recently active first, at most `TOP_ROWS`. */
  rows: ProjectRow[];
  /** How many more there are than the rows. */
  more: number;
  single: ProjectRow | null;
}

export const OTHER_PROJECT_ID = "__other";

/**
 * 项目: each project with something in the capsule — its memories and documents — the most recently active first; the memories that name
 * no project the account has are one 「其他」. A memory of a project is any memory that is not about the person (`isAboutYou`), so the
 * projects' memories and 关于你's are the whole of the capsule's memories, and the headline's number is the sum of the two cards.
 */
export function projectsCard(doc: Pick<OverviewDoc, "nodes" | "facets" | "summary">): ProjectsCard {
  const aboutYou = (doc.facets.aboutYou ?? []).reduce((sum, kind) => sum + kind.count, 0);
  const named = doc.facets.projects.reduce((sum, project) => sum + project.memories, 0);
  const other = Math.max(0, doc.summary.memories - aboutYou - named);
  const marks = doc.nodes.filter((node) => node.projectId && node.type !== "project");
  const lastAt = (id: string) => marks.filter((node) => node.projectId === id).map((node) => node.at ?? "").sort().at(-1) || null;
  const looks = (id: string) => memoriesOf(doc).filter((node) => node.projectId === id && node.state === "check").length;
  const rows: ProjectRow[] = doc.facets.projects
    .map((project): ProjectRow => ({ id: project.id, name: project.name, memories: project.memories, documents: project.documents, needsLook: looks(project.id), at: lastAt(project.id) }))
    .concat(other > 0 ? [{ id: OTHER_PROJECT_ID, name: "其他", memories: other, documents: 0, needsLook: looks(OTHER_PROJECT_ID), at: lastAt(OTHER_PROJECT_ID) }] : [])
    .filter((row) => row.memories + row.documents > 0)
    .sort((left, right) => String(right.at ?? "").localeCompare(String(left.at ?? "")) || (right.memories + right.documents) - (left.memories + left.documents) || left.name.localeCompare(right.name, "zh"));
  const memories = rows.reduce((sum, row) => sum + row.memories, 0);
  return {
    count: rows.length, memories, shape: rows.length === 0 ? "recipe" : rows.length === 1 ? "single" : "table",
    rows: rows.slice(0, TOP_ROWS), more: Math.max(0, rows.length - TOP_ROWS), single: rows.length === 1 ? rows[0]! : null,
  };
}

// ------------------------------------------------------------------------------------------------ 我的做法

export interface MethodsCard {
  count: number;
  /** `rows` lists the methods; `months` draws them on a month axis (dots up to 30, bars after) with the newest three as rows. */
  shape: "recipe" | "rows" | "months";
  /** Dots or bars: which form the months are drawn in. */
  marks: "dots" | "bars" | null;
  rows: MarkRow[];
  months: Array<{ month: string; count: number }>;
}

/** Each month from the first to the last of a set of days, with how many fell in it — a month with none is a gap, not a missing bar. @param days YYYY-MM-DD or ISO */
export function monthCounts(days: readonly string[]): Array<{ month: string; count: number }> {
  const months = days.filter((day) => /^\d{4}-\d{2}/.test(day)).map((day) => day.slice(0, 7)).sort();
  if (months.length === 0) return [];
  const tally = new Map<string, number>();
  for (const month of months) tally.set(month, (tally.get(month) ?? 0) + 1);
  const out: Array<{ month: string; count: number }> = [];
  const [lastYear, lastMonth] = months.at(-1)!.split("-").map(Number) as [number, number];
  let [year, month] = months[0]!.split("-").map(Number) as [number, number];
  while (year < lastYear || (year === lastYear && month <= lastMonth)) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    out.push({ month: key, count: tally.get(key) ?? 0 });
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return out;
}

/** The day a method was learned, as its row says it: when it was first written. */
const learnedAt = (method: Pick<WebMethod, "createdAt" | "statusChangedAt" | "updatedAt">): string | null => method.createdAt || method.statusChangedAt || method.updatedAt || null;

/** A learned method as a row of a card: its own line (a title), the day it was learned, and the drawer a press opens — the one the memory page opens. */
function methodRow(method: Pick<WebMethod, "id" | "title" | "name" | "createdAt" | "statusChangedAt" | "updatedAt">): MarkRow {
  return { id: `method:${method.id}`, title: methodTitle(method), at: learnedAt(method), node: { type: "method", subtype: null, state: "current" }, open: { kind: "method", id: method.id }, projectId: null };
}

/**
 * 我的做法: what the platform learned to do for this person — the approved methods, as the 做法 tab reads them (`listAllMethods("approved")`), a title and
 * the day it was learned, never a count of use (owner ruling, 2026-09-23: counts of use are the back office's).
 */
export function methodsCard(methods: ReadonlyArray<Pick<WebMethod, "id" | "title" | "name" | "createdAt" | "statusChangedAt" | "updatedAt" | "status">>): MethodsCard {
  const rows = newestFirst(methods.filter((method) => method.status === "approved").map(methodRow));
  const count = rows.length;
  const amount = amountOf(count);
  return {
    count, shape: amount === "none" ? "recipe" : amount === "few" ? "rows" : "months",
    marks: amount === "some" ? "dots" : amount === "many" ? "bars" : null,
    rows: amount === "few" ? rows : rows.slice(0, 3),
    months: amount === "some" || amount === "many" ? monthCounts(rows.map((row) => row.at ?? "")) : [],
  };
}

// ------------------------------------------------------------------------------------------------ 知识

export interface KnowledgeCard {
  /** The documents the knowledge base holds, by its own count. */
  count: number;
  shape: "recipe" | "rows" | "types";
  rows: MarkRow[];
  /** At most five kinds of document, the rest as 其他. */
  types: Array<{ id: string; label: string; count: number }>;
  /** The memories resting on a document that changed, was withdrawn or expired. */
  changed: number;
}

/** The kinds of document a card names before it folds the rest. */
export const TYPE_BARS = 5;

/**
 * 知识: the documents, counted by the knowledge base (`facets.documentTypes`: whole, compiled pages left out, not the page of marks) and
 * drawn as what they are — up to five as rows, then a composition by kind with at most five bars and 其他 — and, in amber, how many memories
 * rest on a document that is no longer as it was.
 */
export function knowledgeCard(doc: Pick<OverviewDoc, "nodes" | "facets" | "summary">): KnowledgeCard {
  const documents = doc.nodes.filter((node) => node.type === "document");
  const listed = doc.facets.documentTypes
    ?? Object.entries(documents.reduce<Record<string, number>>((tally, node) => ({ ...tally, [node.group ?? "资料"]: (tally[node.group ?? "资料"] ?? 0) + 1 }), {})).map(([label, count]) => ({ id: label, label, count }));
  const sorted = [...listed].sort((left, right) => right.count - left.count || left.id.localeCompare(right.id));
  const count = doc.facets.documentTypes ? sorted.reduce((sum, type) => sum + type.count, 0) : doc.summary.documents;
  const types = sorted.length <= TYPE_BARS ? sorted : [...sorted.slice(0, TYPE_BARS - 1), { id: "other", label: "其他", count: sorted.slice(TYPE_BARS - 1).reduce((sum, type) => sum + type.count, 0) }];
  const rows = newestFirst(documents.map(rowOf));
  const changed = memoriesOf(doc).filter((node) => node.state === "check" && String(node.reason ?? "").startsWith("source-")).length;
  const shape = count === 0 ? "recipe" : count <= FEW_MAX && rows.length >= count ? "rows" : "types";
  return { count, shape, rows: shape === "rows" ? rows.slice(0, count) : [], types, changed };
}

// ------------------------------------------------------------------------------------------------ 收到的

export interface ReceivedCard {
  count: number;
  shape: "recipe" | "rows";
  rows: ReceivedCapsule[];
  more: number;
}

/** 收到的: the packs other people shared and this account took in, the newest first, with the switch that puts one in force. */
export function receivedCard(packs: readonly ReceivedCapsule[]): ReceivedCard {
  const ordered = [...packs].sort((left, right) => String(right.importedAt ?? "").localeCompare(String(left.importedAt ?? "")) || left.id.localeCompare(right.id));
  return { count: ordered.length, shape: ordered.length === 0 ? "recipe" : "rows", rows: ordered.slice(0, TOP_ROWS), more: Math.max(0, ordered.length - TOP_ROWS) };
}

/** The three things a person's way of working is said in. */
export interface WorkStyle { methods: number; standards: number; background: number; total: number }

/**
 * 工作方式: what a capsule would hand over, in the three named categories of its card — 方法 (a way of doing the work), 标准与偏好 (how it
 * should come out: preferences, writing habits, corrections, the tools used) and 背景 (who they are and what they know) — from the entries a
 * preview lists. The kinds are the capsule's own (`CAPSULE_FACT_KINDS`); one that is none of the first two is background.
 */
export function workStyle(entries: ReadonlyArray<{ factKind: string }>): WorkStyle {
  const standards = new Set(["preference", "writing_style", "correction", "tooling", "behavior"]);
  let methods = 0;
  let others = 0;
  let background = 0;
  for (const entry of entries) {
    if (entry.factKind === "method_preference") methods += 1;
    else if (standards.has(entry.factKind)) others += 1;
    else background += 1;
  }
  return { methods, standards: others, background, total: methods + others + background };
}

// ------------------------------------------------------------------------------------------------ 需要看一眼

export interface LookRow {
  id: string;
  title: string;
  /** Why it needs a look, in the reader's words. */
  reason: string;
  open: MapOpen | null;
  node: Pick<MapNode, "type" | "subtype" | "state">;
}

const REASON_ORDER: readonly MapReason[] = ["source-retracted", "conflict", "source-changed", "source-expired", "expired"];

/** What needs a second look — a source a memory rests on changed, two statements disagree — the most worth knowing first, five of them. */
export function needsLook(doc: Pick<OverviewDoc, "nodes" | "summary">): { count: number; rows: LookRow[]; more: number } {
  const marked = memoriesOf(doc).filter((node) => node.state === "check").sort((left, right) => {
    const rank = (node: MapNode) => { const at = REASON_ORDER.indexOf(node.reason as MapReason); return at < 0 ? REASON_ORDER.length : at; };
    return rank(left) - rank(right) || String(right.at ?? "").localeCompare(String(left.at ?? "")) || left.id.localeCompare(right.id);
  });
  const count = Math.max(doc.summary.needsLook, marked.length);
  const rows = marked.slice(0, LOOK_ROWS).map((node): LookRow => ({
    id: node.id, title: node.label, reason: REASON_TEXT[node.reason as MapReason] ?? "需要看一眼", open: node.open ?? null, node: { type: node.type, subtype: node.subtype, state: node.state },
  }));
  return { count, rows, more: Math.max(0, count - rows.length) };
}

// ------------------------------------------------------------------------------------------------ 成长

export type Lane = "noted" | "learned" | "documents" | "received";
/** The lanes of the strip, top to bottom, with the word and the shape of each: the capsule's gains, and nothing it lost. */
export const LANES: readonly Lane[] = ["noted", "learned", "documents", "received"];
export const LANE_WORDS: Readonly<Record<Lane, string>> = { noted: "记下", learned: "学会", documents: "资料", received: "收下" };
export const LANE_GLYPHS: Readonly<Record<Lane, string>> = { noted: "●", learned: "▲", documents: "■", received: "◆" };
/** How a lane's count is worded in the card's sentence. */
const LANE_UNITS: Readonly<Record<Lane, (count: number) => string>> = {
  noted: (count) => `记下 ${count} 件`, learned: (count) => `学会 ${count} 种做法`, documents: (count) => `放进 ${count} 份资料`, received: (count) => `收下 ${count} 个胶囊`,
};

/** One gain: a memory noted, a method learned, a document added, a pack taken in — on the day it happened in the researcher's zone. */
export interface GrowthEvent {
  lane: Lane;
  /** YYYY-MM-DD in the researcher's zone. */
  day: string;
  title: string | null;
  /** What a press opens: a drawer, or the page of that lane when the event is one of a count (a document). */
  open: MapOpen | null;
}

/**
 * The gains of the capsule, one event each: the memories noted (a memory replaced since is not counted twice — what replaced it carries
 * on), the methods learned (the 做法 tab's own list), the documents added (the knowledge base's own days) and the packs received. A lane is drawn only when it has
 * events; what was replaced or forgotten is the map's 时间 view, not this one.
 */
export function growthEvents(
  doc: Pick<OverviewDoc, "nodes" | "events" | "buckets" | "scope">,
  received: readonly Pick<ReceivedCapsule, "title" | "importedAt">[],
  methods: ReadonlyArray<Pick<WebMethod, "id" | "title" | "name" | "createdAt" | "statusChangedAt" | "updatedAt" | "status">> = [],
): GrowthEvent[] {
  const zone = doc.scope.timeZone;
  const byId = new Map(doc.nodes.map((node) => [node.id, node]));
  const events: GrowthEvent[] = [];
  const dayOf = (at: string) => { const ms = Date.parse(at); return Number.isFinite(ms) ? dayIn(ms, zone) : null; };
  for (const event of doc.events) {
    if (event.type !== "memory" || changeKindOf(event) !== "noted") continue;
    const node = byId.get(event.ref);
    if (node?.state === "replaced") continue;
    const day = dayOf(event.at);
    if (day) events.push({ lane: "noted", day, title: event.text || node?.label || null, open: node?.open ?? null });
  }
  for (const method of methods) {
    if (method.status !== "approved") continue;
    const at = learnedAt(method);
    const day = at ? dayOf(at) : null;
    if (day) events.push({ lane: "learned", day, title: methodTitle(method), open: { kind: "method", id: method.id } });
  }
  for (const bucket of doc.buckets.series) {
    for (let index = 0; index < (Number(bucket.document) || 0); index += 1) events.push({ lane: "documents", day: bucket.t, title: null, open: null });
  }
  for (const pack of received) {
    const day = pack.importedAt ? dayOf(pack.importedAt) : null;
    if (day) events.push({ lane: "received", day, title: pack.title, open: null });
  }
  return events.sort((left, right) => left.day.localeCompare(right.day) || LANES.indexOf(left.lane) - LANES.indexOf(right.lane));
}

export interface Growth {
  total: number;
  /** The lanes that have events, in the strip's order. */
  lanes: Lane[];
  counts: Record<Lane, number>;
  /** The first day anything was gained, and today. */
  first: string | null;
  today: string;
  /** A dot for each event up to thirty in all; weekly counts for each lane after that. */
  shape: "none" | "dots" | "weeks";
  /** 「自 9 月 22 日起，记下 18 件、学会 3 种做法、放进 47 份资料」: what the strip adds up to, in the grammar of the time view's sentence. */
  title: string | null;
  /** The axis counts days under 14 days of history and weeks after. */
  axis: "days" | "weeks";
  weeks: Array<{ start: string; end: string; counts: Record<Lane, number> }>;
}

const DAY_MS = 86_400_000;
const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const emptyCounts = (): Record<Lane, number> => ({ noted: 0, learned: 0, documents: 0, received: 0 });

/** The strip: its lanes, its counts, the form it is drawn in and the sentence it proves. @param today YYYY-MM-DD in the researcher's zone */
export function growthOf(events: readonly GrowthEvent[], today: string, formatDay: (day: string) => string): Growth {
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
  return {
    total, lanes, counts, first, today: last, shape: total === 0 ? "none" : total <= DOT_LIMIT ? "dots" : "weeks",
    title: first ? `自${formatDay(first)}起，${lanes.map((lane) => LANE_UNITS[lane](counts[lane])).join("、")}` : null,
    axis: span < 14 ? "days" : "weeks", weeks,
  };
}

/** The strip of a capsule, from what the overview read: the gains and what they add up to. */
export function growthCard(
  doc: Pick<OverviewDoc, "nodes" | "events" | "buckets" | "scope">,
  received: readonly Pick<ReceivedCapsule, "title" | "importedAt">[],
  methods: Parameters<typeof growthEvents>[2] = [],
  now: Date = new Date(),
): Growth {
  return growthOf(growthEvents(doc, received, methods), dayIn(now.getTime(), doc.scope.timeZone), (day) => formatDay(day, now));
}

/** How many gains fell in the last thirty days, in the researcher's zone. */
export function recentGains(events: readonly GrowthEvent[], today: string): number {
  const from = addDays(today, -29);
  return events.filter((event) => event.day >= from && event.day <= today).length;
}

// ------------------------------------------------------------------------------------------------ the sentence over the cards

/** What the headline says, each number only when its part was read. `null`: that read failed, and the sentence leaves the number out. */
export interface HeadlineFacts {
  /** The memories about the person and in projects. */
  memories: number | null;
  methods: number | null;
  documents: number | null;
  /** The gains of the last thirty days. */
  recent: number | null;
}

/** Where each number of the headline leads: the part it counts. */
export interface HeadlineLinks { memories: string; methods: string; documents: string; recent: string }

/**
 * The one sentence over the page, in the shape of the map's: what the capsule holds, each number a link to its part, and the last
 * month's gains. It names what was read and no more — a number whose read failed is not in it, and not a zero in its place — and says
 * so plainly when the capsule holds documents or methods and no memory yet. `null` when there is nothing to say (an empty capsule's
 * cards are recipes, and a headline of zeros is a statistic about nothing).
 */
export function overviewHeadline(facts: HeadlineFacts, links: HeadlineLinks): NotePart[] | null {
  const holds: NotePart[][] = [];
  if (facts.memories) holds.push([{ n: facts.memories, to: links.memories, label: `${facts.memories} 件关于你和项目的事，看地图` }, " 件关于你和项目的事"]);
  if (facts.methods) holds.push([{ n: facts.methods, to: links.methods, label: `${facts.methods} 种做法，看地图` }, " 种做法"]);
  if (facts.documents) holds.push([{ n: facts.documents, to: links.documents, label: `${facts.documents} 份资料，看地图` }, " 份资料"]);
  if (holds.length === 0) return null;
  const parts: NotePart[] = ["胶囊里有 "];
  holds.forEach((hold, index) => { if (index > 0) parts.push("、"); parts.push(...hold); });
  if (facts.memories === 0) parts.push("，还没有记下关于你的事");
  if (facts.recent) parts.push("；近 30 天新增 ", { n: facts.recent, to: links.recent, label: `${facts.recent} 件，看时间` }, " 件");
  parts.push("。");
  return parts;
}

/** The address a part of the overview opens: the map narrowed to it (`part`), or its own page. */
export function partAddress(part: MapPart | "growth" | "look"): string {
  switch (part) {
    case "growth": return "/app/memory/map?view=time";
    case "look": return "/app/memory/map?look=1";
    default: return `/app/memory/map?part=${part}`;
  }
}
