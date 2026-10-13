/**
 * Where the marks of the relation graph stand: worked out once, here, the same way every time, and arranged so it can be read.
 *
 * Why not the library's own force layout, and not a force layout of our own (the first version of this file was one): a force
 * layout starts from random positions, so the same data lands differently on every load — the complaint Obsidian's users make
 * above all others (spec §1.1) — and, run on a few dozen marks hanging from a few hubs, it pushes each hub's marks into a line at
 * the edge of the picture. A map a researcher reads is better served by a plan: the account in the middle, each project a hub
 * around it, and each hub's marks laid round it on a spiral, the heaviest nearest. Positions depend only on the marks' ids and
 * weights, so the same marks give the same picture, a replay never moves a mark that is already there, and a dragged mark is the
 * reader's own act. A document, an outside source or an entity stands beside the marks it is tied to.
 *
 * Deletable if the library's layout takes a fixed seed and learns to keep a hub's marks round it.
 */

export interface LayoutNode {
  id: string;
  type: string;
  /** The hub a mark belongs to: a project's id; null for the account's own. */
  home: string | null;
  weight: number;
}
export interface LayoutEdge {
  from: string;
  to: string;
}

/** The box the positions are in, wide like the canvas it is fitted to. */
export const LAYOUT_WIDTH = 1800;
export const LAYOUT_HEIGHT = 900;

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** How far apart neighbours on a hub's spiral stand, in the box's units. */
const SPACING = 38;
/** The spiral is a little flattened, like the box. */
const SQUASH = 0.8;

/** A number in [0, 1) that depends on the text only. */
export function unitHash(text: string, salt = 0): number {
  let hash = 2166136261 ^ salt;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 2246822507);
  hash ^= hash >>> 13;
  return (hash >>> 0) / 4294967296;
}

type Point = { x: number; y: number };

/** The i-th place on a sunflower spiral round a centre: even spacing, no two marks on one spot. */
function spiral(index: number, centre: Point, spacing: number, turn: number): Point {
  const radius = spacing * Math.sqrt(index + 1.4);
  const angle = index * GOLDEN_ANGLE + turn;
  return { x: centre.x + Math.cos(angle) * radius, y: centre.y + Math.sin(angle) * radius * SQUASH };
}

export function layoutGraph(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[]): Map<string, [number, number]> {
  const centre: Point = { x: LAYOUT_WIDTH / 2, y: LAYOUT_HEIGHT / 2 };
  const place = new Map<string, Point>();
  const byImportance = (left: LayoutNode, right: LayoutNode) => right.weight - left.weight || left.id.localeCompare(right.id);
  const hubs = nodes.filter((node) => node.type === "project").sort((left, right) => left.id.localeCompare(right.id));
  const hubKey = (node: LayoutNode) => node.home ?? node.id.slice(node.id.indexOf(":") + 1);
  const members = (key: string) => nodes.filter((node) => node.type !== "project" && node.type !== "you" && node.home === key && !node.id.startsWith("project:")).sort(byImportance);

  // The account in the middle.
  for (const node of nodes) if (node.type === "you") place.set(node.id, centre);

  // Each hub on an ellipse round it, sharing the circle by how much it has to hold: a hub with more marks takes more of the way round.
  const sizes = hubs.map((hub) => Math.sqrt(members(hubKey(hub)).length + 3));
  const total = sizes.reduce((sum, size) => sum + size, 0) || 1;
  let sweep = -Math.PI / 2 - (sizes[0] ?? 0) / total * Math.PI;
  hubs.forEach((hub, index) => {
    const share = (sizes[index] / total) * Math.PI * 2;
    const angle = sweep + share / 2;
    sweep += share;
    const hubAt = { x: centre.x + Math.cos(angle) * LAYOUT_WIDTH * 0.335, y: centre.y + Math.sin(angle) * LAYOUT_HEIGHT * 0.29 };
    place.set(hub.id, hubAt);
    const turn = unitHash(hub.id, 4) * Math.PI * 2;
    members(hubKey(hub)).forEach((node, order) => place.set(node.id, spiral(order, hubAt, SPACING, turn)));
  });

  // The account's own marks (and a mark whose hub is not drawn) ring the account, leaving its hexagon room.
  const ringed = nodes.filter((node) => node.type !== "you" && node.type !== "project" && !place.has(node.id)
    && (node.type === "memory" || node.type === "method" || node.type === "cluster") && (node.home === null || !hubs.some((hub) => hubKey(hub) === node.home))).sort(byImportance);
  ringed.forEach((node, order) => place.set(node.id, spiral(order + 5, centre, SPACING * 0.92, 1.1)));

  // Whatever is tied to marks stands beside them, pushed out from the middle so it does not cover them; what is tied to nothing is
  // set on an outer ring by its name.
  const tied = new Map<string, string[]>();
  for (const edge of edges) {
    tied.set(edge.from, [...(tied.get(edge.from) ?? []), edge.to]);
    tied.set(edge.to, [...(tied.get(edge.to) ?? []), edge.from]);
  }

  // A group that is tied only to itself — the entities of a compiled knowledge graph and the lines between them, the pages and their
  // links — is a hub of its own: its marks are laid round a place no other hub has taken, the best connected nearest, and not
  // scattered round the outer ring with every line between them a long one.
  const loose = new Set(nodes.filter((node) => !place.has(node.id) && !(tied.get(node.id) ?? []).some((id) => place.has(id))).map((node) => node.id));
  const groups: string[][] = [];
  const seen = new Set<string>();
  for (const id of [...loose].sort()) {
    if (seen.has(id)) continue;
    const group: string[] = [];
    const queue = [id];
    seen.add(id);
    while (queue.length > 0) {
      const next = queue.shift() as string;
      group.push(next);
      for (const other of tied.get(next) ?? []) if (loose.has(other) && !seen.has(other)) { seen.add(other); queue.push(other); }
    }
    if (group.length >= 3) groups.push(group);
  }
  for (const group of groups.sort((left, right) => right.length - left.length || left[0].localeCompare(right[0]))) {
    // The place farthest from everything laid so far, on the outer ellipse.
    let best: Point = { x: centre.x + LAYOUT_WIDTH * 0.4, y: centre.y };
    let bestGap = -1;
    for (let step = 0; step < 24; step += 1) {
      const angle = (step / 24) * Math.PI * 2 + unitHash(group[0], 8) * 0.2;
      const candidate = { x: centre.x + Math.cos(angle) * LAYOUT_WIDTH * 0.4, y: centre.y + Math.sin(angle) * LAYOUT_HEIGHT * 0.36 };
      const gap = Math.min(...[...place.values()].map((point) => Math.hypot(point.x - candidate.x, (point.y - candidate.y) * 1.6)), 1e9);
      if (gap > bestGap) { bestGap = gap; best = candidate; }
    }
    const degree = (id: string) => (tied.get(id) ?? []).length;
    group.sort((left, right) => degree(right) - degree(left) || left.localeCompare(right));
    const turn = unitHash(group[0], 9) * Math.PI * 2;
    group.forEach((id, order) => place.set(id, spiral(order, best, SPACING * 0.95, turn)));
  }
  for (const node of [...nodes].sort((left, right) => left.id.localeCompare(right.id))) {
    if (place.has(node.id)) continue;
    const near = (tied.get(node.id) ?? []).map((id) => place.get(id)).filter((point): point is Point => point !== undefined);
    if (near.length > 0) {
      const mean = { x: near.reduce((sum, point) => sum + point.x, 0) / near.length, y: near.reduce((sum, point) => sum + point.y, 0) / near.length };
      const away = Math.atan2(mean.y - centre.y, mean.x - centre.x) || unitHash(node.id, 5) * Math.PI * 2;
      const wobble = (unitHash(node.id, 6) - 0.5) * 1.1;
      place.set(node.id, { x: mean.x + Math.cos(away + wobble) * 64, y: mean.y + Math.sin(away + wobble) * 58 });
    } else {
      const angle = unitHash(node.id, 7) * Math.PI * 2;
      place.set(node.id, { x: centre.x + Math.cos(angle) * LAYOUT_WIDTH * 0.42, y: centre.y + Math.sin(angle) * LAYOUT_HEIGHT * 0.4 });
    }
  }

  return new Map([...place.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([id, point]) => [id, [
    Math.round(Math.max(24, Math.min(LAYOUT_WIDTH - 24, point.x)) * 10) / 10, Math.round(Math.max(24, Math.min(LAYOUT_HEIGHT - 24, point.y)) * 10) / 10,
  ] as [number, number]]));
}
