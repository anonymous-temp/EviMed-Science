/**
 * What a ring picture draws, decided before WebGL is asked: the segments round the ring, the cell each thing gets in its segment, the
 * cloud each segment keeps inside the ring, the curves between things and what a pointer is on. Every function is a plain function of
 * the spec, so all of it is tested without a browser; `ringScene.ts` only paints the answers.
 *
 * Two pictures use it — 记忆星环 (a person's memories, one cell each, a segment a kind or a project) and 主动科研's observatory (a run's
 * operations, a segment a stage, the members as clouds at the stage of their last call) — and each says what its parts mean in its own
 * adapter (`memoryRing.ts`, `researchRing.ts`).
 *
 * Geometry is in units of the ring: the cells stand on the circle of radius 1 and reach outwards; the clouds are inside it; the arcs,
 * the labels and the ticks are outside. Angles are measured clockwise from the top, so a segment list reads like a clock.
 *
 * Why a cell stands where it stands: **its segment and its order of arrival in it, and nothing else.** No force layout, no randomness:
 * the same spec is the same ring, a new cell takes the end of its segment and the segment's cells close up by a fraction of a cell.
 */

export type RingCellState = "current" | "replaced" | "running" | "error";

export interface RingSegment {
  id: string;
  /** The segment's word beside the ring. */
  label: string;
  /** A short Latin code shown beside the word (PLAN, FACTS), set apart from it. */
  code?: string;
  /** A star token (`--star-<tone>`) for its arc. */
  tone: string;
  /** What its label counts; the cells it holds when absent. */
  count?: number;
}

export interface RingCell {
  id: string;
  segment: string;
  /** Its place among its segment's cells: lower first. */
  order: number;
  /** When it began, in ms, for the replay; null when nothing says. */
  at: number | null;
  /** How far it reaches out of the ring, 0 to 1. */
  length: number;
  /** How bright it is drawn, 0 to 1. */
  bright: number;
  /** A star token for its colour. */
  tone: string;
  state: RingCellState;
  /** A spark flies to it from the centre now and then: a memory recalled lately, an operation under way. */
  spark?: boolean;
}

export interface RingCluster {
  id: string;
  /** The segment it stands in, or null for a place round the centre. */
  segment: string | null;
  tone: string;
  /** How many particles it is drawn with. */
  mass: number;
  label?: string;
  /** It is working now: it breathes faster and its lines flow. */
  live?: boolean;
}

export interface RingLink {
  id: string;
  /** A cell, a cluster or `centre`. */
  from: string;
  to: string;
  tone: string;
  /** Its resting brightness, 0 to 1. */
  strength: number;
  /** Light travels along it, from `from` to `to`. */
  flow: boolean;
}

export interface RingSpec {
  segments: RingSegment[];
  cells: RingCell[];
  clusters: RingCluster[];
  links: RingLink[];
  /** Particles each cell keeps in its segment's cloud: the cloud is the cells' own light. */
  particlesPerCell: number;
  centre: { label: string; tone: string };
  /** Something is under way: the scanning sweep turns. */
  live?: boolean;
}

/** The radii of the picture, in units of the ring. */
export const RING = {
  /** Where a cell stands. */
  cell: 1,
  /** The shortest and the longest a cell reaches. */
  cellShort: 0.05,
  cellLong: 0.2,
  /** Where a link leaves a cell: a little inside it. */
  foot: 0.97,
  /** The inner guide circle. */
  guide: 0.9,
  /** The segments' arcs, the labels, the tick circle. */
  arc: 1.3,
  label: 1.42,
  ticks: 1.52,
  /** Where a segment's cloud stands. */
  anchor: 0.52,
  /** How far the centre's cloud spreads. */
  core: 0.12,
  /** The room the picture needs from its centre, labels included: the frame fits this. */
  reach: 1.6,
} as const;

export const TAU = Math.PI * 2;
/** The gap between two segments, in radians. */
export const SEGMENT_GAP = 0.045;

export type Point = readonly [number, number];

/** A place at an angle (clockwise from the top) and a radius. */
export function polar(angle: number, radius: number): [number, number] {
  return [Math.sin(angle) * radius, Math.cos(angle) * radius];
}

/** The angle of a place, clockwise from the top, in [0, 2π). */
export function angleOf(x: number, y: number): number {
  const angle = Math.atan2(x, y);
  return angle < 0 ? angle + TAU : angle;
}

/** How far apart two angles are, the short way round. */
export function angularDistance(left: number, right: number): number {
  const d = Math.abs(left - right) % TAU;
  return d > Math.PI ? TAU - d : d;
}

export interface PlacedSegment {
  id: string;
  /** Where it begins and ends, and its middle. */
  a0: number;
  a1: number;
  mid: number;
  /** Its cells in order. */
  cells: string[];
  /** Where its cloud stands. */
  anchor: Point;
}

export interface RingLayout {
  segments: PlacedSegment[];
  /** Each cell's angle. */
  angles: Map<string, number>;
  segmentOf: Map<string, string>;
  /** Each cluster's place. */
  clusters: Map<string, Point>;
  /** The narrowest gap between two neighbouring cells, in radians: what a pointer may miss by. */
  spacing: number;
}

/**
 * Where everything stands. A segment is as wide as its share of the cells, and counts as at least a third of the average segment's cells, so a
 * stage nobody reached or a kind with one memory still has an arc and a label; its cells are spread evenly across it in their order.
 */
export function layoutRing(spec: Pick<RingSpec, "segments" | "cells" | "clusters">): RingLayout {
  const bySegment = new Map(spec.segments.map((segment) => [segment.id, [] as RingCell[]]));
  for (const cell of spec.cells) bySegment.get(cell.segment)?.push(cell);
  for (const list of bySegment.values()) list.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  const total = [...bySegment.values()].reduce((sum, list) => sum + list.length, 0);
  const floor = Math.max(1, total / Math.max(1, spec.segments.length) / 3);
  const units = spec.segments.map((segment) => Math.max((bySegment.get(segment.id) as RingCell[]).length, floor));
  const unitSum = units.reduce((sum, value) => sum + value, 0) || 1;
  const gap = spec.segments.length > 1 ? SEGMENT_GAP : 0;
  const room = TAU - gap * spec.segments.length;

  const angles = new Map<string, number>();
  const segmentOf = new Map<string, string>();
  const segments: PlacedSegment[] = [];
  let spacing = Infinity;
  let at = gap / 2;
  spec.segments.forEach((segment, index) => {
    const width = (room * units[index]) / unitSum;
    const cells = bySegment.get(segment.id) as RingCell[];
    cells.forEach((cell, k) => {
      angles.set(cell.id, at + ((k + 0.5) * width) / cells.length);
      segmentOf.set(cell.id, segment.id);
    });
    if (cells.length) spacing = Math.min(spacing, width / cells.length);
    const mid = at + width / 2;
    segments.push({ id: segment.id, a0: at, a1: at + width, mid, cells: cells.map((cell) => cell.id), anchor: spec.segments.length > 1 ? polar(mid, RING.anchor) : [0, 0] });
    at += width + gap;
  });

  // Clusters in one segment stand round its anchor, the first on it; clusters of the centre stand round the centre.
  const clusters = new Map<string, Point>();
  const crowd = new Map<string, number>();
  for (const cluster of spec.clusters) {
    const key = cluster.segment ?? "";
    const slot = crowd.get(key) ?? 0;
    crowd.set(key, slot + 1);
    const home = segments.find((segment) => segment.id === cluster.segment);
    if (!home) {
      // Round the centre and never on it: the centre is the picture's own mark, and its label and its hover stay free.
      clusters.set(cluster.id, polar(0.7 + slot * 2.4, 0.24));
      continue;
    }
    const along = slot === 0 ? 0 : (slot % 2 ? 1 : -1) * Math.ceil(slot / 2) * Math.min(0.22, (home.a1 - home.a0) / 3);
    const depth = slot === 0 ? RING.anchor : RING.anchor - 0.1 * (Math.ceil(slot / 2) % 2);
    clusters.set(cluster.id, polar(home.mid + along, depth));
  }
  return { segments, angles, segmentOf, clusters, spacing: Number.isFinite(spacing) ? spacing : TAU };
}

/** Where a link begins or ends: a cell's foot, a cluster, or the centre; null for anything the layout does not hold. */
export function placeOf(layout: RingLayout, id: string): Point | null {
  if (id === "centre") return [0, 0];
  const angle = layout.angles.get(id);
  if (angle !== undefined) return polar(angle, RING.foot);
  return layout.clusters.get(id) ?? null;
}

function segmentAnchor(layout: RingLayout, id: string, clusters: ReadonlyMap<string, string | null>): Point | null {
  const segment = layout.segmentOf.get(id) ?? clusters.get(id) ?? null;
  return layout.segments.find((placed) => placed.id === segment)?.anchor ?? null;
}

function cubic(p0: Point, p1: Point, p2: Point, p3: Point, samples: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i <= samples; i += 1) {
    const t = i / samples;
    const u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    out.push([a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]]);
  }
  return out;
}

const scale = (point: Point, k: number): Point => [point[0] * k, point[1] * k];

/**
 * The points of a link's curve. Between two segments it bends through both clouds and past the centre, so the lines between two kinds run
 * together (Holten's bundling, by shared control points); inside one segment it loops gently inwards; to or from the centre it passes its
 * segment's cloud. Null when an end is not in the picture.
 */
export function linkPath(layout: RingLayout, from: string, to: string, clusters: ReadonlyMap<string, string | null> = new Map(), samples = 28): Point[] | null {
  const start = placeOf(layout, from);
  const end = placeOf(layout, to);
  if (!start || !end) return null;
  const a = from === "centre" ? null : segmentAnchor(layout, from, clusters);
  const b = to === "centre" ? null : segmentAnchor(layout, to, clusters);
  if (a && b && a === b) return cubic(start, scale(a, 1.12), scale(b, 1.12), end, samples);
  const c1 = a ? scale(a, 0.55) : scale(end, 0.35);
  const c2 = b ? scale(b, 0.55) : scale(start, 0.35);
  return cubic(start, c1, c2, end, samples);
}

/** The flight of a spark: from the centre, or from a cluster, through the cell's cloud to its foot. */
export function sparkPath(layout: RingLayout, cell: string, from: string = "centre", samples = 24): Point[] | null {
  const end = placeOf(layout, cell);
  const start = placeOf(layout, from);
  const angle = layout.angles.get(cell);
  if (!end || !start || angle === undefined) return null;
  const segment = layout.segments.find((placed) => placed.id === layout.segmentOf.get(cell));
  const through = segment ? segment.anchor : polar(angle, RING.anchor);
  return cubic(start, scale(through, 0.8), polar(angle, 0.78), end, samples);
}

/** A place along a sampled curve, `t` from 0 to 1. */
export function along(points: readonly Point[], t: number): Point {
  if (points.length === 0) return [0, 0];
  const at = Math.max(0, Math.min(1, t)) * (points.length - 1);
  const index = Math.min(points.length - 2, Math.floor(at));
  if (index < 0) return points[0];
  const k = at - index;
  const [x0, y0] = points[index];
  const [x1, y1] = points[index + 1];
  return [x0 + (x1 - x0) * k, y0 + (y1 - y0) * k];
}

/** How far a cell reaches out of the ring, from its `length`. */
export function cellReach(length: number): number {
  return RING.cellShort + (RING.cellLong - RING.cellShort) * Math.max(0, Math.min(1, length));
}

export type RingHit =
  | { kind: "cell"; id: string }
  | { kind: "segment"; id: string }
  | { kind: "cluster"; id: string }
  | { kind: "centre" }
  | null;

/**
 * What a place is on, in units of the ring. `slop` is how much a pointer may miss by, in units too (14 CSS pixels over the ring's radius):
 * a cell a hairline wide is a target that size. On the cells' band the nearest cell whose bar is within the slop along the ring; on the
 * arcs and labels the segment; inside, a cluster under the pointer, the centre, or the segment whose cloud is nearest.
 */
export function ringHit(layout: RingLayout, x: number, y: number, slop: number, shown?: ReadonlySet<string> | null): RingHit {
  const r = Math.hypot(x, y);
  const angle = angleOf(x, y);
  if (r >= RING.cell - slop && r <= RING.cell + RING.cellLong + slop) {
    let best: string | null = null;
    let bestDistance = Infinity;
    for (const [id, cellAngle] of layout.angles) {
      if (shown && !shown.has(id)) continue;
      const d = angularDistance(angle, cellAngle);
      if (d < bestDistance) { best = id; bestDistance = d; }
    }
    // Within the slop of the bar itself, measured along the ring: a sparse ring's empty arc is no target, however wide its cells' share.
    if (best && bestDistance * Math.max(r, 0.5) <= slop) return { kind: "cell", id: best };
  }
  const segmentAt = () => layout.segments.find((segment) => {
    const from = segment.a0 - SEGMENT_GAP / 2;
    const span = segment.a1 - segment.a0 + SEGMENT_GAP;
    return ((angle - from) % TAU + TAU) % TAU <= span;
  }) ?? null;
  if (r >= RING.arc - 0.08 && r <= RING.label + 0.2) {
    const segment = segmentAt();
    if (segment) return { kind: "segment", id: segment.id };
  }
  if (r < RING.cell - slop) {
    let cluster: string | null = null;
    let clusterDistance = Infinity;
    for (const [id, place] of layout.clusters) {
      const d = Math.hypot(place[0] - x, place[1] - y);
      if (d < clusterDistance) { cluster = id; clusterDistance = d; }
    }
    if (cluster && clusterDistance <= Math.max(0.08, slop)) return { kind: "cluster", id: cluster };
    if (r <= RING.core * 1.3) return { kind: "centre" };
    let segment: string | null = null;
    let segmentDistance = Infinity;
    for (const placed of layout.segments) {
      const d = Math.hypot(placed.anchor[0] - x, placed.anchor[1] - y);
      if (d < segmentDistance) { segment = placed.id; segmentDistance = d; }
    }
    if (segment && segmentDistance <= 0.24) return { kind: "segment", id: segment };
  }
  return null;
}

/** The cells a thing is tied to, itself included: the ends of its links, a segment's cells, a cluster's links. */
export function neighbourhood(spec: Pick<RingSpec, "links">, layout: RingLayout, hit: RingHit): Set<string> | null {
  if (!hit || hit.kind === "centre") return null;
  if (hit.kind === "segment") return new Set(layout.segments.find((segment) => segment.id === hit.id)?.cells ?? []);
  const near = new Set([hit.id]);
  for (const link of spec.links) {
    if (link.from === hit.id) near.add(link.to);
    if (link.to === hit.id) near.add(link.from);
  }
  return near;
}

export interface LabelBox { id: string; mid: number; width: number; height: number; short: number }
export interface PlacedLabel { id: string; x: number; y: number; full: boolean; shown: boolean }

/**
 * Where each segment's label stands, in units of the ring, so no two overlap: each at its segment's middle, a little further out at the sides
 * (a label there reads across the ring); one that would overlap a label already placed steps outwards twice, then drops its Latin code, and a
 * label that still has no room is not drawn (its segment says its word in the tooltip and the legend). `width` and `short` are the label's
 * widths with and without its code, `height` its height, all in units of the ring.
 */
export function placeLabels(labels: readonly LabelBox[]): PlacedLabel[] {
  const placed: Array<{ x0: number; x1: number; y0: number; y1: number }> = [];
  const overlaps = (box: { x0: number; x1: number; y0: number; y1: number }) => placed.some((other) => box.x0 < other.x1 && box.x1 > other.x0 && box.y0 < other.y1 && box.y1 > other.y0);
  const out: PlacedLabel[] = [];
  for (const label of [...labels].sort((left, right) => left.mid - right.mid)) {
    let done: PlacedLabel | null = null;
    for (const full of [true, false]) {
      const width = full ? label.width : label.short;
      for (let step = 0; step < 3 && !done; step += 1) {
        const radius = RING.label + 0.1 * Math.abs(Math.sin(label.mid)) + step * 0.09;
        const [x, y] = polar(label.mid, radius);
        // A label left of the ring reads towards it, so its box grows leftwards from its anchor; right of it, rightwards; at the top or bottom, both ways.
        const side = Math.sin(label.mid);
        const x0 = side > 0.3 ? x - width * 0.15 : side < -0.3 ? x - width * 0.85 : x - width / 2;
        const box = { x0, x1: x0 + width, y0: y - label.height / 2, y1: y + label.height / 2 };
        if (!overlaps(box)) { placed.push(box); done = { id: label.id, x: x0 + width / 2, y, full, shown: true }; }
      }
      if (done) break;
    }
    out.push(done ?? { id: label.id, x: 0, y: 0, full: false, shown: false });
  }
  return out;
}

/** The earliest moment a cell says it began, or null when none does. */
export function replayStart(cells: ReadonlyArray<Pick<RingCell, "at">>): number | null {
  const times = cells.map((cell) => cell.at).filter((at): at is number => typeof at === "number" && Number.isFinite(at));
  return times.length ? Math.min(...times) : null;
}
