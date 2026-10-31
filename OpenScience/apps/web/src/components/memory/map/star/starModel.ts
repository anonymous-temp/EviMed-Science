import type { MapEdge, MapNode } from "@/lib/memoryMapClient";
import { unitHash } from "@/components/charts/map/layout";

/**
 * What the star map draws, decided before WebGL is asked (the way `graphOption.ts` does for the relation graph). Every function here is a plain
 * function of the document, so all of it is tested without a browser; `starScene.ts` only paints the answers.
 *
 * Why a mark stands where it stands: **the place of a mark depends on its own id and weight and on its hub, and on nothing else.** Force layouts — the
 * usual 3D graph — start from random positions, and a picture a person returns to must not move (Obsidian's users' first complaint, and
 * 2D beating 3D on spatial memory in the studies is what a 3D map has to fight): a new memory takes its place and no other mark moves, so the replay
 * and the next visit are the same sky. A project's hub takes the next place on one golden-angle spiral by when the project began.
 */

/** What a mark is, for its colour, its shape and its word in the legend. */
export type StarFamily = "about" | "preference" | "correction" | "fact" | "decision" | "method" | "document" | "entity";
export type StarShape = "ball" | "crystal" | "pyramid" | "sheet";

export const STAR_FAMILIES: Readonly<Record<StarFamily, { word: string; shape: StarShape }>> = {
  about: { word: "关于你", shape: "ball" },
  preference: { word: "偏好", shape: "ball" },
  correction: { word: "纠正", shape: "crystal" },
  fact: { word: "项目事实", shape: "ball" },
  decision: { word: "决定", shape: "crystal" },
  method: { word: "做法", shape: "pyramid" },
  document: { word: "资料", shape: "sheet" },
  entity: { word: "概念", shape: "ball" },
};
export const STAR_FAMILY_ORDER = Object.keys(STAR_FAMILIES) as StarFamily[];

const MEMORY_FAMILY: Readonly<Record<string, StarFamily>> = {
  profile: "about", behavior: "about", preference: "preference", correction: "correction", decision: "decision",
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
export function encodingWords(nodes: readonly MapNode[], now: number): string[] {
  const memories = nodes.filter((node) => node.type === "memory");
  return [
    memories.some((node) => node.state !== "replaced") ? "越亮越新、越常用到" : "",
    memories.some((node) => isRecentlyRecalled(node, now)) ? "流光是最近被想起" : "",
    memories.some((node) => node.state === "replaced") ? "灰色连橙线是已被替代" : "",
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

/** How large a mark is drawn, in the scene's units. */
export function sizeOf(node: Pick<MapNode, "type" | "weight" | "count" | "state">): number {
  const weight = Math.max(0, Math.min(1, node.weight ?? 0.4));
  if (node.type === "cluster") return 6.5 + Math.min(7, Math.log2(1 + (node.count ?? 1)) * 1.5);
  if (node.state === "replaced") return 2.6;
  if (node.type === "entity") return 2 + weight * 2;
  if (node.type === "document" || node.type === "page" || node.type === "reference") return 4.2;
  return 3 + weight * 4.6;
}

/**
 * A shared pack as a small sky, the sender at its centre: only what the page already lists under it, one mark an entry, with no dates and no lines, because the pack carries neither
 * and the sender's memory is not what was shared.
 */
export function packSky(entries: ReadonlyArray<{ id: string; factKind: string; text: string }>, sender: string | null): { nodes: MapNode[]; edges: MapEdge[] } {
  const you: MapNode = { id: YOU_HUB, type: "you", label: sender ?? "对方" };
  return { nodes: [you, ...entries.map((entry): MapNode => ({ id: `memory:${entry.id}`, type: "memory", subtype: entry.factKind, label: entry.text, weight: 0.6, state: "current" }))], edges: [] };
}

// ---------------------------------------------------------------------------------------------------- where it stands

export type Point3 = readonly [number, number, number];
export interface StarHub { id: string; label: string; kind: "you" | "project"; position: Point3; size: number }
export interface StarLayout {
  hubs: StarHub[];
  /** Every mark's place, hubs included. */
  positions: Map<string, Point3>;
  /** The hub each mark hangs from. */
  homes: Map<string, string>;
  /** How far from the centre most of the picture reaches. */
  reach: number;
}

export const YOU_HUB = "you:account";
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** The shells round a hub, in the scene's units: the heaviest stand nearest, and what is not a memory stands outside. */
const SHELL = { accountInner: 55, accountOuter: 125, projectInner: 42, projectOuter: 135, methodInner: 150, methodOuter: 176, outerInner: 138, outerOuter: 166, beside: 40, replaced: 26 };
/** The picture is a little flattened, like the card it is in. */
const SQUASH = 0.78;

/** A direction from the id alone: uniform on the sphere, so marks are spread with no one of them knowing of another. */
function directionOf(id: string): Point3 {
  const y = 2 * unitHash(id, 41) - 1;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const a = unitHash(id, 43) * Math.PI * 2;
  return [Math.cos(a) * r, y, Math.sin(a) * r];
}
const plus = (at: Point3, direction: Point3, distance: number): Point3 => [at[0] + direction[0] * distance, at[1] + direction[1] * distance * SQUASH, at[2] + direction[2] * distance];

/** The place of the i-th project: one spiral round the account, never closer than the shells can hold, each new project on from the last. */
function hubPlace(index: number): Point3 {
  const angle = 0.5 + index * GOLDEN_ANGLE;
  const ring = 250 + 36 * Math.sqrt(index);
  const lift = ((index * 0.618034) % 1 - 0.5) * 130;
  return [Math.cos(angle) * ring, lift, Math.sin(angle) * ring];
}

/**
 * Where everything stands. Given the whole document, so a narrowing never moves a mark. Projects are ordered by the earliest mark that hangs from them
 * and then by id, so a new project takes the next place and those before it stay.
 */
export function layoutStars(nodes: readonly MapNode[], edges: readonly MapEdge[]): StarLayout {
  const first = new Map<string, number>();
  for (const node of nodes) {
    const at = Date.parse(node.at ?? "");
    if (!node.projectId || !Number.isFinite(at)) continue;
    first.set(node.projectId, Math.min(first.get(node.projectId) ?? Infinity, at));
  }
  const projects = nodes.filter((node) => node.type === "project").slice().sort((left, right) => {
    const a = first.get(left.projectId ?? left.id.slice("project:".length)) ?? Infinity;
    const b = first.get(right.projectId ?? right.id.slice("project:".length)) ?? Infinity;
    return a - b || left.id.localeCompare(right.id);
  });
  const hubs: StarHub[] = [{ id: YOU_HUB, label: nodes.find((node) => node.type === "you")?.label ?? "你", kind: "you", position: [0, 0, 0], size: 13 }];
  projects.forEach((project, index) => hubs.push({ id: project.id, label: project.label, kind: "project", position: hubPlace(index), size: 8.5 }));
  const positions = new Map<string, Point3>(hubs.map((hub) => [hub.id, hub.position]));
  const homes = new Map<string, string>();
  const homeOf = (node: MapNode) => (node.projectId && positions.has(`project:${node.projectId}`) ? `project:${node.projectId}` : YOU_HUB);

  const away: MapNode[] = [];
  const beside: MapNode[] = [];
  for (const node of nodes) {
    if (node.type === "you" || node.type === "project") continue;
    const home = homeOf(node);
    homes.set(node.id, home);
    const centre = positions.get(home) as Point3;
    const weight = Math.max(0, Math.min(1, node.weight ?? 0.4));
    const nearness = 0.2 + 0.8 * (1 - weight);
    const jitter = (unitHash(node.id, 47) - 0.5) * 26;
    if (node.state === "replaced" || node.type === "entity") { beside.push(node); continue; }
    if (node.type === "memory" || node.type === "cluster") {
      const [inner, outer] = home === YOU_HUB ? [SHELL.accountInner, SHELL.accountOuter] : [SHELL.projectInner, SHELL.projectOuter];
      positions.set(node.id, plus(centre, directionOf(node.id), inner + (outer - inner) * nearness + jitter));
    } else if (node.type === "method") {
      positions.set(node.id, plus(centre, directionOf(node.id), SHELL.methodInner + (SHELL.methodOuter - SHELL.methodInner) * unitHash(node.id, 53)));
    } else {
      away.push(node);
    }
  }
  // What is not a memory stands outside the hub's shells, on the side away from the account, so its lines do not cross the account's own marks.
  for (const node of away) {
    const home = homes.get(node.id) as string;
    const centre = positions.get(home) as Point3;
    const out = Math.hypot(...centre) || 1;
    const raw = directionOf(node.id);
    const direction: Point3 = home === YOU_HUB ? raw : [raw[0] + (centre[0] / out) * 0.9, raw[1], raw[2] + (centre[2] / out) * 0.9];
    const length = Math.hypot(...direction) || 1;
    positions.set(node.id, plus(centre, [direction[0] / length, direction[1] / length, direction[2] / length], SHELL.outerInner + (SHELL.outerOuter - SHELL.outerInner) * unitHash(node.id, 59)));
  }
  // What is tied to another mark stands beside it: a concept by its document, an old statement by what replaced it (following a chain back to its head).
  const replacedBy = new Map(edges.filter((edge) => edge.type === "replaces").map((edge) => [edge.to, edge.from]));
  const tiedTo = new Map<string, string>();
  for (const edge of edges) {
    if (edge.type === "belongs-to") continue;
    if (!tiedTo.has(edge.from)) tiedTo.set(edge.from, edge.to);
    if (!tiedTo.has(edge.to)) tiedTo.set(edge.to, edge.from);
  }
  const place = (node: MapNode, trail: Set<string>): Point3 => {
    const held = positions.get(node.id);
    if (held) return held;
    const anchorId = node.state === "replaced" ? replacedBy.get(node.id) : tiedTo.get(node.id);
    const anchor = anchorId && !trail.has(anchorId) ? nodes.find((other) => other.id === anchorId) : undefined;
    const home = positions.get(homes.get(node.id) as string) as Point3;
    const base = anchor ? place(anchor, trail.add(node.id)) : home;
    const at = plus(base, directionOf(node.id), anchor ? (node.state === "replaced" ? SHELL.replaced : SHELL.beside) : SHELL.outerInner);
    positions.set(node.id, at);
    return at;
  };
  for (const node of beside) place(node, new Set());

  // How far the picture reaches, to frame it: the far edge of most of it, so one stray document does not make everything small.
  const distances = [...positions.values()].map((place) => Math.hypot(...place)).sort((left, right) => left - right);
  const reach = Math.max(120, distances[Math.floor((distances.length - 1) * 0.92)] ?? 0);
  return { hubs, positions, homes, reach };
}

/** The closest the camera starts: a few stars are a few stars, and not a close-up of one. */
const HOME_NEAREST = 300;

/** How far back the camera stands to hold the picture in a canvas of this shape. */
export function homeDistance(reach: number, fovDegrees: number, aspect: number): number {
  const half = (fovDegrees * Math.PI) / 360;
  const fit = Math.min(Math.tan(half), Math.tan(half) * aspect);
  return Math.max(HOME_NEAREST, (reach * 0.98) / Math.max(0.05, fit));
}

// ---------------------------------------------------------------------------------------------------- the lines

export type FibreKind = "axon" | "trunk" | MapEdge["type"];
export interface StarFibre { kind: FibreKind; from: string; to: string; at?: string | null }

/**
 * Every line of the picture: each mark's own axon to its hub, each project's trunk to the account and the lines that say something. A mark's belonging is
 * drawn by its axon, so `belongs-to` draws nothing of its own; a concept has no axon, because it hangs from the document it stands beside.
 */
export function fibresOf(nodes: readonly MapNode[], edges: readonly MapEdge[], layout: StarLayout): StarFibre[] {
  const fibres: StarFibre[] = layout.hubs.filter((hub) => hub.kind === "project").map((hub) => ({ kind: "trunk", from: YOU_HUB, to: hub.id }));
  for (const node of nodes) {
    const home = layout.homes.get(node.id);
    if (home && node.type !== "entity" && node.state !== "replaced") fibres.push({ kind: "axon", from: home, to: node.id });
  }
  for (const edge of edges) {
    if (edge.type !== "belongs-to" && layout.positions.has(edge.from) && layout.positions.has(edge.to)) fibres.push({ kind: edge.type, from: edge.from, to: edge.to, at: edge.at ?? null });
  }
  return fibres;
}

/** The marks tied to a mark, itself included, by the lines that say something and by its hub. */
export function neighboursOf(id: string, fibres: readonly StarFibre[]): Set<string> {
  const near = new Set([id]);
  for (const fibre of fibres) {
    if (fibre.from === id) near.add(fibre.to);
    if (fibre.to === id) near.add(fibre.from);
  }
  return near;
}

// ---------------------------------------------------------------------------------------------------- pressing a mark

export interface ScreenMark { id: string; x: number; y: number; depth: number; radius: number }

/** The most a press may miss by, in CSS pixels: a star far off is a dot, and a dot is not a target. */
export const PICK_SLOP = 14;

/**
 * The mark a pointer is on: the nearest whose drawn size or `PICK_SLOP` holds the pointer, and of those at about one place the one in front. On the screen and
 * not along a ray, because a far star is a pixel wide and a ray misses it; and a target this large is what lets a slowly turning picture be pressed at all.
 */
export function nearestMark(marks: readonly ScreenMark[], x: number, y: number): string | null {
  let best: ScreenMark | null = null;
  let bestScore = Infinity;
  for (const mark of marks) {
    const distance = Math.hypot(mark.x - x, mark.y - y);
    if (distance > Math.max(PICK_SLOP, mark.radius + 4)) continue;
    const score = distance + mark.depth * 8;
    if (score < bestScore) { best = mark; bestScore = score; }
  }
  return best?.id ?? null;
}

// ---------------------------------------------------------------------------------------------------- the replay

/** The earliest moment the picture has a mark, or null when none says when it began. */
export function replayStart(nodes: readonly MapNode[]): number | null {
  const times = nodes.map((node) => Date.parse(node.at ?? "")).filter(Number.isFinite);
  return times.length ? Math.min(...times) : null;
}

/** What a mark is at one moment of the replay: not yet there, in force, or already replaced. Null `cutoff` is now. */
export function markAt(node: Pick<MapNode, "at" | "until" | "state">, cutoff: number | null): "absent" | "current" | "replaced" {
  if (cutoff === null) return node.state === "replaced" ? "replaced" : "current";
  const began = Date.parse(node.at ?? "");
  if (Number.isFinite(began) && began > cutoff) return "absent";
  if (node.state !== "replaced") return "current";
  const until = Date.parse(node.until ?? "");
  return Number.isFinite(until) && until > cutoff ? "current" : "replaced";
}
