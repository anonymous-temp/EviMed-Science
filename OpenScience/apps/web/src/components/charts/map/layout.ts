/**
 * Where the marks of the relation graph stand: worked out once, here, the same way every time.
 *
 * Why not the library's own force layout: it starts from random positions, so the same data lands differently on every load —
 * the complaint Obsidian's users make above all others (spec §1.1) — and it animates for as long as it runs, which a researcher
 * reads as the map being unsettled. This is a small Fruchterman–Reingold over the marks the page holds (at most 300), started from
 * positions that depend only on the marks' ids, run for a fixed number of steps: the same marks give the same picture, a replay
 * never moves a mark that is already there, and a dragged mark is the reader's own act.
 *
 * Deletable if the library's layout takes a fixed seed.
 */

export interface LayoutNode {
  id: string;
  type: string;
  /** Marks of one group start near each other: a project's, or the account's. */
  home: string | null;
  weight: number;
}
export interface LayoutEdge {
  from: string;
  to: string;
}

/** The box the positions are in. The library fits it to the canvas. */
export const LAYOUT_SIZE = 1000;
const STEPS = 160;

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

export function layoutGraph(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[]): Map<string, [number, number]> {
  const ordered = [...nodes].sort((left, right) => left.id.localeCompare(right.id));
  const centre = LAYOUT_SIZE / 2;
  const homes = [...new Set(ordered.map((node) => node.home).filter((home): home is string => Boolean(home)))].sort();
  const place = new Map<string, { x: number; y: number }>();
  for (const node of ordered) {
    if (node.type === "you") { place.set(node.id, { x: centre, y: centre }); continue; }
    const homeIndex = node.home ? homes.indexOf(node.home) : -1;
    const homeAngle = homeIndex < 0 ? unitHash(node.id, 1) * Math.PI * 2 : (homeIndex / Math.max(1, homes.length)) * Math.PI * 2;
    const around = node.type === "project" ? 0 : (unitHash(node.id, 2) - 0.5) * 1.2;
    const radius = node.type === "project" ? LAYOUT_SIZE * 0.22 : LAYOUT_SIZE * (0.26 + 0.2 * unitHash(node.id, 3));
    place.set(node.id, { x: centre + Math.cos(homeAngle + around) * radius, y: centre + Math.sin(homeAngle + around) * radius });
  }
  const links = edges.filter((edge) => place.has(edge.from) && place.has(edge.to) && edge.from !== edge.to);
  const area = LAYOUT_SIZE * LAYOUT_SIZE;
  const k = Math.sqrt(area / Math.max(1, ordered.length)) * 0.72;
  const velocity = new Map(ordered.map((node) => [node.id, { x: 0, y: 0 }]));
  let temperature = LAYOUT_SIZE / 9;
  for (let step = 0; step < STEPS; step += 1) {
    for (const node of velocity.values()) { node.x = 0; node.y = 0; }
    for (let left = 0; left < ordered.length; left += 1) {
      const a = place.get(ordered[left].id) as { x: number; y: number };
      for (let right = left + 1; right < ordered.length; right += 1) {
        const b = place.get(ordered[right].id) as { x: number; y: number };
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distance = Math.hypot(dx, dy);
        if (distance < 0.01) { dx = unitHash(ordered[left].id, 7) - 0.5; dy = unitHash(ordered[right].id, 8) - 0.5; distance = Math.hypot(dx, dy) || 0.01; }
        const push = (k * k) / distance;
        const va = velocity.get(ordered[left].id) as { x: number; y: number };
        const vb = velocity.get(ordered[right].id) as { x: number; y: number };
        va.x += (dx / distance) * push; va.y += (dy / distance) * push;
        vb.x -= (dx / distance) * push; vb.y -= (dy / distance) * push;
      }
    }
    for (const link of links) {
      const a = place.get(link.from) as { x: number; y: number };
      const b = place.get(link.to) as { x: number; y: number };
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const distance = Math.hypot(dx, dy) || 0.01;
      const pull = (distance * distance) / k;
      const va = velocity.get(link.from) as { x: number; y: number };
      const vb = velocity.get(link.to) as { x: number; y: number };
      va.x -= (dx / distance) * pull; va.y -= (dy / distance) * pull;
      vb.x += (dx / distance) * pull; vb.y += (dy / distance) * pull;
    }
    for (const node of ordered) {
      const p = place.get(node.id) as { x: number; y: number };
      const v = velocity.get(node.id) as { x: number; y: number };
      // A weak pull to the middle keeps the parts that are not tied to each other from drifting off the canvas.
      v.x += (centre - p.x) * 0.05; v.y += (centre - p.y) * 0.05;
      if (node.type === "you") continue;
      const speed = Math.hypot(v.x, v.y) || 0.01;
      const move = Math.min(speed, temperature);
      p.x += (v.x / speed) * move; p.y += (v.y / speed) * move;
      p.x = Math.max(20, Math.min(LAYOUT_SIZE - 20, p.x));
      p.y = Math.max(20, Math.min(LAYOUT_SIZE - 20, p.y));
    }
    temperature *= 0.965;
  }
  return new Map(ordered.map((node) => {
    const p = place.get(node.id) as { x: number; y: number };
    return [node.id, [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10] as [number, number]];
  }));
}
