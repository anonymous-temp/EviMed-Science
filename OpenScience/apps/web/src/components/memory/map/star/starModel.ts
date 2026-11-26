import type { MapEdge, MapNode } from "@/lib/memoryMapClient";

/**
 * The memory's kinds and how a mark is drawn, for 记忆星环 (`memoryRing.ts` places them on the ring) and for the legend over it: a mark's kind,
 * its brightness and the words for it, whether it was recalled lately, and a shared pack as marks. Plain functions of the document, so all of it
 * is tested without a browser.
 */

/** What a mark is, for its colour, its segment and its word in the legend. */
export type StarFamily = "person" | "note" | "about" | "preference" | "correction" | "fact" | "decision" | "method" | "document" | "entity";

export const STAR_FAMILIES: Readonly<Record<StarFamily, { word: string }>> = {
  person: { word: "人物" },
  note: { word: "其他记忆" },
  about: { word: "关于你" },
  preference: { word: "偏好" },
  correction: { word: "纠正" },
  fact: { word: "项目事实" },
  decision: { word: "决定" },
  method: { word: "做法" },
  document: { word: "资料" },
  entity: { word: "概念" },
};
export const STAR_FAMILY_ORDER = Object.keys(STAR_FAMILIES) as StarFamily[];

const MEMORY_FAMILY: Readonly<Record<string, StarFamily>> = {
  person: "person", note: "note", profile: "about", behavior: "about", preference: "preference", correction: "correction", decision: "decision",
  project_fact: "fact", analysis: "fact", follow_up: "fact", run_summary: "fact",
  // A capsule's own kinds, as a shared pack's entries say them.
  method_preference: "method", writing_style: "preference", tooling: "preference",
};
const TYPE_FAMILY: Readonly<Record<string, StarFamily>> = { method: "method", document: "document", page: "document", reference: "document", entity: "entity" };

/** The family of a mark; a cluster is the family of what it folds, and the two marks of the structure have none. */
export function familyOf(node: Pick<MapNode, "type" | "subtype" | "memberType">): StarFamily | null {
  if (node.type === "you" || node.type === "project") return null;
  const type = node.type === "cluster" ? node.memberType ?? "memory" : node.type;
  if (type === "memory") return MEMORY_FAMILY[String(node.subtype)] ?? "about";
  return TYPE_FAMILY[type] ?? "document";
}

/** The legend: each family the picture has, with how many marks it holds (a cluster counts what it folds), in the one order. */
export function familyCounts(nodes: readonly MapNode[]): Array<{ family: StarFamily; word: string; count: number }> {
  const counts = new Map<StarFamily, number>();
  for (const node of nodes) {
    const family = familyOf(node);
    if (family && node.state !== "replaced") counts.set(family, (counts.get(family) ?? 0) + (node.type === "cluster" ? node.count ?? 1 : 1));
  }
  return STAR_FAMILY_ORDER.filter((family) => counts.has(family)).map((family) => ({ family, word: STAR_FAMILIES[family].word, count: counts.get(family) ?? 0 }));
}

/** The encodings the legend names, only those the picture has (spec §2: a legend describes the picture it is under). */
export function encodingWords(nodes: readonly MapNode[], now: number, linked = false): string[] {
  const memories = nodes.filter((node) => node.type === "memory");
  return [
    memories.some((node) => node.state !== "replaced") ? "一格一条，越亮越新、越常用到" : "",
    memories.some((node) => isRecentlyRecalled(node, now)) ? "光点飞向最近被想起的" : "",
    linked ? "线上的流光是它们的关联" : "",
    memories.some((node) => node.state === "replaced") ? "灰色是已被替代" : "",
  ].filter(Boolean);
}

/** How long a recalled memory sends its spark. */
const RECENT_RECALL_MS = 3 * 86_400_000;
export function isRecentlyRecalled(node: Pick<MapNode, "recalledAt" | "state">, now: number): boolean {
  if (node.state === "replaced" || !node.recalledAt) return false;
  const age = now - Date.parse(node.recalledAt);
  return age >= 0 && age < RECENT_RECALL_MS;
}

/** How bright a mark is drawn: a memory says so itself, and what has no such word stands at an even middle. */
export function brightnessOf(node: Pick<MapNode, "type" | "freshness" | "state">): number {
  if (node.state === "replaced") return 0;
  return typeof node.freshness === "number" ? Math.max(0, Math.min(1, node.freshness)) : 0.7;
}

/** A memory's brightness in the reader's words, for the tooltip: it says what happened and promises nothing, because a dim memory is recalled as a bright one is. */
export function freshnessWord(node: Pick<MapNode, "type" | "freshness" | "state">): string {
  if (node.type !== "memory" || typeof node.freshness !== "number") return "";
  if (node.state === "replaced") return "已被替代";
  if (node.freshness >= 0.66) return "最近用到";
  if (node.freshness >= 0.33) return "有一阵没用到";
  return "很久没用到，仍然记着";
}

/** The account's own mark, the centre of the ring. */
export const YOU_HUB = "you:account";

/**
 * A shared pack as marks, the sender at the centre: only what the page already lists under it, one mark an entry, with no dates and no lines, because the pack carries neither
 * and the sender's memory is not what was shared.
 */
export function packSky(entries: ReadonlyArray<{ id: string; factKind: string; text: string }>, sender: string | null): { nodes: MapNode[]; edges: MapEdge[] } {
  const you: MapNode = { id: YOU_HUB, type: "you", label: sender ?? "对方" };
  return { nodes: [you, ...entries.map((entry): MapNode => ({ id: `memory:${entry.id}`, type: "memory", subtype: entry.factKind, label: entry.text, weight: 0.6, state: "current" }))], edges: [] };
}

/** The earliest moment the picture has a mark, or null when none says when it began. */
export function replayStart(nodes: readonly MapNode[]): number | null {
  const times = nodes.map((node) => Date.parse(node.at ?? "")).filter(Number.isFinite);
  return times.length ? Math.min(...times) : null;
}
